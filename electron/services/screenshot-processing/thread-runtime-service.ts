import { BrowserWindow } from "electron";
import { generateObject, NoObjectGeneratedError } from "ai";
import { and, desc, eq, gte, isNotNull, lt, ne } from "drizzle-orm";

import { IPC_CHANNELS } from "@shared/ipc-types";
import type { Thread } from "@shared/context-types";
import type {
  ThreadBrief,
  ThreadBriefUpdatedPayload,
  ThreadLensStateSnapshot,
} from "@shared/thread-lens-types";

import { getDb } from "../../database";
import {
  activityEvents,
  activitySummaries,
  contextNodes,
  threads,
  userSetting,
} from "../../database/schema";
import { getLogger } from "../logger";
import { userSettingService } from "../user-setting-service";
import { AISDKService } from "../ai-sdk-service";
import { aiRuntimeService } from "../ai-runtime-service";
import { llmUsageService } from "../llm-usage-service";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";

import { screenshotProcessingEventBus } from "./event-bus";
import type { ScreenshotProcessingEventMap } from "./events";
import { threadsService } from "./threads-service";
import { contextSearchService } from "./context-search-service";
import { processingConfig } from "./config";
import { promptTemplates } from "./prompt-templates";
import {
  CANONICAL_APP_CANDIDATES,
  ThreadBriefLLMSchema,
  ThreadBriefLLMProcessedSchema,
} from "./schemas";

const threadRuntimeLogger = getLogger("thread-runtime-service");
const threadBriefLogger = getLogger("thread-brief-service");
const threadLensStateLogger = getLogger("thread-lens-state-service");

type RefreshType = "threshold" | "force";

const BRIEF_DIRTY_NODECOUNT_DELTA = 50;
const BRIEF_DIRTY_ACTIVE_AT_DELTA_MS = 10 * 60 * 1000;
const BRIEF_REGEN_DEBOUNCE_MS = 1500;

type LastGeneratedState = {
  nodeCount: number;
  lastActiveAt: number;
  generatedAt: number;
};

type DirtyState = {
  token: number;
};

type CacheKey = string;

function buildCacheKey(args: { threadId: string; lastActiveAt: number }): CacheKey {
  return `${args.threadId}:${args.lastActiveAt}`;
}

class ThreadBriefService {
  private cache = new Map<CacheKey, ThreadBrief>();
  private lastGeneratedByThreadId = new Map<string, LastGeneratedState>();
  private dirtyByThreadId = new Map<string, DirtyState>();
  private dirtyTokenByThreadId = new Map<string, number>();
  private regenTimers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();

  queueRefresh(args: { threadId: string; type: "threshold" | "force" }): void {
    const threadId = args.threadId.trim();
    if (!threadId) return;

    const last = this.lastGeneratedByThreadId.get(threadId);
    if (!last) {
      return;
    }

    const thread = threadsService.getThreadById(threadId);
    if (!thread) return;

    if (args.type === "threshold") {
      const nodeDelta = thread.nodeCount - last.nodeCount;
      const activeAtDelta = thread.lastActiveAt - last.lastActiveAt;
      if (nodeDelta < BRIEF_DIRTY_NODECOUNT_DELTA) return;
      if (activeAtDelta < BRIEF_DIRTY_ACTIVE_AT_DELTA_MS) return;
    }

    this.markDirtyInternal({ threadId });
  }

  queueRefreshMany(args: { threadIds: string[]; type: "threshold" | "force" }): void {
    for (const rawId of args.threadIds) {
      const threadId = rawId.trim();
      if (!threadId) continue;
      this.queueRefresh({ threadId, type: args.type });
    }
  }

  private scheduleRegen(args: { threadId: string; token: number; delayMs: number }): void {
    const existing = this.regenTimers.get(args.threadId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.regenTimers.delete(args.threadId);
      void this.regenerateIfDirty(args.threadId, args.token).catch((error) => {
        threadBriefLogger.error(
          { error, threadId: args.threadId },
          "Failed to regenerate dirty thread brief"
        );
      });
    }, args.delayMs);

    this.regenTimers.set(args.threadId, timer);
  }

  private markDirtyInternal(args: { threadId: string }): void {
    const prevToken = this.dirtyTokenByThreadId.get(args.threadId) ?? 0;
    const nextToken = prevToken + 1;

    this.dirtyTokenByThreadId.set(args.threadId, nextToken);
    this.dirtyByThreadId.set(args.threadId, {
      token: nextToken,
    });

    this.scheduleRegen({
      threadId: args.threadId,
      token: nextToken,
      delayMs: BRIEF_REGEN_DEBOUNCE_MS,
    });
  }

  private async regenerateIfDirty(threadId: string, token: number): Promise<void> {
    const dirty = this.dirtyByThreadId.get(threadId);
    if (!dirty || dirty.token !== token) return;

    if (this.inFlight.has(threadId)) {
      this.scheduleRegen({ threadId, token, delayMs: 250 });
      return;
    }

    this.inFlight.add(threadId);
    try {
      const brief = await this.getBrief({ threadId, force: true });
      if (!brief) return;

      this.broadcastBriefUpdated({
        threadId: brief.threadId,
        lastActiveAt: brief.lastActiveAt,
        updatedAt: brief.updatedAt,
      });
    } finally {
      this.inFlight.delete(threadId);
      const stillDirty = this.dirtyByThreadId.get(threadId);
      if (stillDirty?.token === token) {
        this.dirtyByThreadId.delete(threadId);
      }
    }
  }

  private broadcastBriefUpdated(payload: ThreadBriefUpdatedPayload): void {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC_CHANNELS.THREADS_BRIEF_UPDATED, payload);
      }
    } catch {
      // ignore when running in tests
    }
  }

  async getBrief(args: { threadId: string; force: boolean }): Promise<ThreadBrief | null> {
    const threadId = args.threadId.trim();
    if (!threadId) return null;

    const thread = threadsService.getThreadById(threadId);
    if (!thread) return null;

    const cacheKey = buildCacheKey({ threadId: thread.id, lastActiveAt: thread.lastActiveAt });
    if (!args.force) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const aiService = AISDKService.getInstance();
    if (!aiService.isInitialized()) {
      return null;
    }

    const recentNodes = await contextSearchService.getThread(threadId, { limit: 50 });

    const evidenceJson = JSON.stringify(
      recentNodes.map((n) => ({
        id: n.id,
        event_time: n.eventTime,
        kind: n.kind,
        title: n.title,
        summary: n.summary,
        app_hint: n.appContext?.appHint ?? null,
        window_title: n.appContext?.windowTitle ?? null,
        project_key: n.appContext?.projectKey ?? null,
        project_name: n.appContext?.projectName ?? null,
        keywords: n.keywords ?? [],
        entities: n.entities ?? [],
        knowledge: n.knowledge ?? null,
        state_snapshot: n.stateSnapshot ?? null,
      })),
      null,
      2
    );

    const threadJson = JSON.stringify(
      {
        id: thread.id,
        title: thread.title,
        summary: thread.summary,
        current_phase: thread.currentPhase ?? null,
        current_focus: thread.currentFocus ?? null,
        status: thread.status,
        start_time: thread.startTime,
        last_active_at: thread.lastActiveAt,
        duration_ms: thread.durationMs,
        node_count: thread.nodeCount,
        apps: thread.apps,
        main_project: thread.mainProject ?? null,
        key_entities: thread.keyEntities,
      },
      null,
      2
    );

    const userPrompt = promptTemplates.getThreadBriefUserPrompt({
      threadJson,
      evidenceJson,
      appCandidatesJson: JSON.stringify(CANONICAL_APP_CANDIDATES, null, 2),
    });

    const release = await aiRuntimeService.acquire("text");
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);

    try {
      const { object, usage } = await generateObject({
        model: aiService.getTextClient(),
        schema: ThreadBriefLLMSchema,
        mode: "json",
        system: promptTemplates.getThreadBriefSystemPrompt(),
        prompt: userPrompt,
        abortSignal: controller.signal,
        providerOptions: {
          mnemora: {},
        },
      });

      const parsed = ThreadBriefLLMProcessedSchema.parse(object);
      const durationMs = Date.now() - startTime;

      await llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        status: "succeeded",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        totalTokens: usage?.totalTokens ?? 0,
        usageStatus: usage ? "present" : "missing",
      });

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        model: aiService.getTextModelName(),
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(parsed, null, 2),
      });

      aiRuntimeService.recordSuccess("text");

      const brief: ThreadBrief = {
        threadId: thread.id,
        lastActiveAt: thread.lastActiveAt,
        briefMarkdown: parsed.briefMarkdown,
        highlights: parsed.highlights,
        currentFocus: parsed.currentFocus,
        nextSteps: parsed.nextSteps,
        updatedAt: Date.now(),
      };

      this.cache.set(cacheKey, brief);
      this.lastGeneratedByThreadId.set(thread.id, {
        nodeCount: thread.nodeCount,
        lastActiveAt: thread.lastActiveAt,
        generatedAt: Date.now(),
      });
      return brief;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (NoObjectGeneratedError.isInstance(error)) {
        threadBriefLogger.error(
          {
            errorName: error.name,
            rawText: error.text,
            rawResponse: error.response,
            cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
          },
          "Thread brief NoObjectGeneratedError"
        );
      } else {
        threadBriefLogger.error({ error }, "Thread brief request failed");
      }

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        model: aiService.getTextModelName(),
        durationMs,
        status: "failed",
        errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });

      await llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        status: "failed",
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        usageStatus: "missing",
      });

      aiRuntimeService.recordFailure("text", error);
      return null;
    } finally {
      clearTimeout(timeoutId);
      release();
    }
  }
}

type ThreadRow = {
  id: string;
  title: string;
  summary: string;
  currentPhase: string | null;
  currentFocus: string | null;
  status: "active" | "inactive" | "closed";
  startTime: number;
  lastActiveAt: number;
  durationMs: number;
  nodeCount: number;
  apps: string;
  mainProject: string | null;
  keyEntities: string;
  milestones: string | null;
  createdAt: number;
  updatedAt: number;
};

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    currentPhase: row.currentPhase ?? undefined,
    currentFocus: row.currentFocus ?? undefined,
    status: row.status,
    startTime: row.startTime,
    lastActiveAt: row.lastActiveAt,
    durationMs: row.durationMs,
    nodeCount: row.nodeCount,
    apps: safeJsonParse<string[]>(row.apps, []),
    mainProject: row.mainProject ?? undefined,
    keyEntities: safeJsonParse<string[]>(row.keyEntities, []),
    milestones: row.milestones ? safeJsonParse<unknown>(row.milestones, undefined) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const THREAD_SELECT = {
  id: threads.id,
  title: threads.title,
  summary: threads.summary,
  currentPhase: threads.currentPhase,
  currentFocus: threads.currentFocus,
  status: threads.status,
  startTime: threads.startTime,
  lastActiveAt: threads.lastActiveAt,
  durationMs: threads.durationMs,
  nodeCount: threads.nodeCount,
  apps: threads.apps,
  mainProject: threads.mainProject,
  keyEntities: threads.keyEntities,
  milestones: threads.milestones,
  createdAt: threads.createdAt,
  updatedAt: threads.updatedAt,
} as const;

function buildSignature(snapshot: ThreadLensStateSnapshot): string {
  const ids = snapshot.topThreads.map((t) => `${t.id}:${t.lastActiveAt}:${t.status}`).join("|");
  return `${snapshot.pinnedThreadId ?? ""}::${snapshot.resolvedThreadId ?? ""}::${ids}`;
}

class ThreadLensStateService {
  private readonly topN = 6;
  private revision = 0;
  private recomputeTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private lastBroadcastSignature: string | null = null;

  private async ensureUserSettingRow(): Promise<void> {
    const db = getDb();
    const existing = db.select({ id: userSetting.id }).from(userSetting).get();
    if (existing) return;
    await userSettingService.getSettings();
  }

  async getLensStateSnapshot(): Promise<ThreadLensStateSnapshot> {
    await this.ensureUserSettingRow();
    const db = getDb();

    const setting = db
      .select({ pinnedThreadId: userSetting.pinnedThreadId })
      .from(userSetting)
      .get();

    const rawPinnedThreadId = setting?.pinnedThreadId ?? null;

    const pinnedRow = rawPinnedThreadId
      ? (db.select(THREAD_SELECT).from(threads).where(eq(threads.id, rawPinnedThreadId)).get() as
          | ThreadRow
          | undefined)
      : undefined;

    const pinned = pinnedRow ? rowToThread(pinnedRow) : null;
    const pinnedValid = pinned != null && pinned.status !== "closed";
    const pinnedThreadId = pinnedValid ? pinned.id : null;

    const recentRows = db
      .select(THREAD_SELECT)
      .from(threads)
      .where(ne(threads.status, "closed"))
      .orderBy(desc(threads.lastActiveAt))
      .limit(this.topN)
      .all() as ThreadRow[];

    const recent = recentRows.map(rowToThread);

    const others = pinnedValid
      ? recent.filter((t) => t.id !== pinned.id).slice(0, Math.max(0, this.topN - 1))
      : recent;

    const topThreads = (pinnedValid ? [pinned, ...others] : others)
      .slice(0, this.topN)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const resolvedThreadId = (() => {
      if (pinnedValid) return pinned.id;
      const active = topThreads.filter((t) => t.status === "active");
      if (active.length > 0) {
        active.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        return active[0]?.id ?? null;
      }
      return topThreads[0]?.id ?? null;
    })();

    return {
      revision: this.revision,
      updatedAt: Date.now(),
      pinnedThreadId,
      topThreads,
      resolvedThreadId,
    };
  }

  markDirty(reason: string): void {
    void reason;
    this.dirty = true;

    if (this.recomputeTimer) {
      return;
    }

    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      void this.recomputeAndBroadcast().catch((error) => {
        threadLensStateLogger.error({ error }, "Failed to recompute and broadcast lens state");
      });
    }, 500);
  }

  private async recomputeAndBroadcast(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    this.dirty = false;
    const snapshot = await this.getLensStateSnapshot();
    const signature = buildSignature(snapshot);

    if (this.lastBroadcastSignature === signature) {
      return;
    }

    this.revision += 1;
    const next: ThreadLensStateSnapshot = {
      ...snapshot,
      revision: this.revision,
      updatedAt: Date.now(),
    };
    this.lastBroadcastSignature = buildSignature(next);

    try {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC_CHANNELS.THREADS_LENS_STATE_CHANGED, { snapshot: next });
      }
    } catch {
      // ignore when running in tests
    }
  }
}

const threadBriefService = new ThreadBriefService();
const threadLensStateService = new ThreadLensStateService();

export class ThreadRuntimeService {
  private started = false;
  private offBatchThreadSucceeded: (() => void) | null = null;
  private offActivitySummarySucceeded: (() => void) | null = null;
  private offThreadsChanged: (() => void) | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;

    this.offBatchThreadSucceeded = screenshotProcessingEventBus.on(
      "batch:thread:succeeded",
      this.onBatchThreadSucceeded
    );

    this.offActivitySummarySucceeded = screenshotProcessingEventBus.on(
      "activity-summary:succeeded",
      this.onActivitySummarySucceeded
    );

    this.offThreadsChanged = screenshotProcessingEventBus.on(
      "threads:changed",
      this.onThreadsChanged
    );
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.offBatchThreadSucceeded) {
      this.offBatchThreadSucceeded();
      this.offBatchThreadSucceeded = null;
    }

    if (this.offActivitySummarySucceeded) {
      this.offActivitySummarySucceeded();
      this.offActivitySummarySucceeded = null;
    }

    if (this.offThreadsChanged) {
      this.offThreadsChanged();
      this.offThreadsChanged = null;
    }
  }

  markLensDirty(reason: string): void {
    threadLensStateService.markDirty(reason);
  }

  async getLensStateSnapshot() {
    return threadLensStateService.getLensStateSnapshot();
  }

  async getBrief(args: { threadId: string; force: boolean }) {
    return threadBriefService.getBrief(args);
  }

  queueBriefRefresh(args: { threadId: string; type: RefreshType }): void {
    threadBriefService.queueRefresh({ threadId: args.threadId, type: args.type });
  }

  queueBriefRefreshMany(args: { threadIds: string[]; type: RefreshType }): void {
    threadBriefService.queueRefreshMany({ threadIds: args.threadIds, type: args.type });
  }

  private readonly onBatchThreadSucceeded = (
    event: ScreenshotProcessingEventMap["batch:thread:succeeded"]
  ) => {
    this.markLensDirty("thread:batch-succeeded");
    this.queueBriefRefresh({ threadId: event.threadId, type: "threshold" });
  };

  private readonly onThreadsChanged = (event: ScreenshotProcessingEventMap["threads:changed"]) => {
    this.markLensDirty(`thread:changed:${event.reason}`);
  };

  private readonly onActivitySummarySucceeded = async (
    event: ScreenshotProcessingEventMap["activity-summary:succeeded"]
  ): Promise<void> => {
    try {
      const { summaryId, windowStart, windowEnd, updatedAt } = event.payload;

      const db = getDb();
      const latest = db
        .select({
          id: activitySummaries.id,
          windowStart: activitySummaries.windowStart,
          windowEnd: activitySummaries.windowEnd,
          updatedAt: activitySummaries.updatedAt,
        })
        .from(activitySummaries)
        .where(eq(activitySummaries.status, "succeeded"))
        .orderBy(desc(activitySummaries.updatedAt))
        .limit(1)
        .get();

      if (!latest) return;

      const isLatestSucceeded =
        summaryId != null
          ? latest.id === summaryId
          : latest.windowStart === windowStart &&
            latest.windowEnd === windowEnd &&
            latest.updatedAt === updatedAt;

      if (!isLatestSucceeded) {
        return;
      }

      const threadIds = new Set<string>();

      const nodeThreadIds = db
        .select({ threadId: contextNodes.threadId })
        .from(contextNodes)
        .where(
          and(
            gte(contextNodes.eventTime, windowStart),
            lt(contextNodes.eventTime, windowEnd),
            isNotNull(contextNodes.threadId)
          )
        )
        .all();

      for (const row of nodeThreadIds) {
        if (row.threadId) {
          threadIds.add(row.threadId);
        }
      }

      if (summaryId != null) {
        const eventThreadIds = db
          .select({ threadId: activityEvents.threadId })
          .from(activityEvents)
          .where(and(eq(activityEvents.summaryId, summaryId), isNotNull(activityEvents.threadId)))
          .all();

        for (const row of eventThreadIds) {
          if (row.threadId) {
            threadIds.add(row.threadId);
          }
        }
      }

      threadBriefService.queueRefreshMany({
        threadIds: Array.from(threadIds),
        type: "force",
      });
    } catch (error) {
      threadRuntimeLogger.error({ error }, "Failed to handle activity-summary:succeeded event");
    }
  };
}

export const threadRuntimeService = new ThreadRuntimeService();
