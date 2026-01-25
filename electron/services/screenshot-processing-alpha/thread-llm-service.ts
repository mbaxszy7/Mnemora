import { desc, eq, ne } from "drizzle-orm";
import { generateObject, NoObjectGeneratedError } from "ai";

import { getDb } from "../../database";
import { contextNodes, threads } from "../../database/schema";
import { getLogger } from "../logger";
import { aiRuntimeService } from "../ai-runtime-service";
import { AISDKService } from "../ai-sdk-service";
import { llmUsageService } from "../llm-usage-service";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";

import { processingConfig } from "./config";
import { promptTemplates } from "./prompt-templates";
import {
  ThreadLLMOutputSchema,
  ThreadLLMOutputProcessedSchema,
  type ThreadLLMOutput,
} from "./schemas";
import type { AppContextPayload, KnowledgePayload, StateSnapshotPayload } from "./types";

const logger = getLogger("thread-llm-service");

type BatchNodeRow = {
  id: number;
  title: string;
  summary: string;
  eventTime: number;
  threadId: string | null;
  threadSnapshot: string | null;
  appContext: string;
  knowledge: string | null;
  stateSnapshot: string | null;
  keywords: string;
};

type ThreadRow = {
  id: string;
  title: string;
  summary: string;
  currentPhase: string | null;
  currentFocus: string | null;
  startTime: number;
  lastActiveAt: number;
  durationMs: number;
  nodeCount: number;
  mainProject: string | null;
  status: "active" | "inactive" | "closed";
};

export class ThreadLlmService {
  async assignForBatch(options: { batchDbId: number; batchNodes: BatchNodeRow[] }): Promise<{
    output: ThreadLLMOutput;
    activeThreadIds: string[];
  }> {
    const db = getDb();
    void options.batchDbId;
    const now = new Date();

    const activeThreads = this.loadActiveThreads(db);
    const threadRecentNodes = this.loadThreadRecentNodes(
      db,
      activeThreads.map((t) => t.id)
    );

    const activeThreadsJson = JSON.stringify(
      activeThreads.map((t) => ({
        thread_id: t.id,
        title: t.title,
        summary: t.summary,
        current_phase: t.currentPhase,
        current_focus: t.currentFocus,
        status: t.status,
        start_time: t.startTime,
        last_active_at: t.lastActiveAt,
        duration_ms: t.durationMs,
        node_count: t.nodeCount,
        main_project: t.mainProject,
      })),
      null,
      2
    );

    const threadRecentNodesJson = JSON.stringify(
      Object.fromEntries(
        threadRecentNodes.map(([threadId, nodes]) => [threadId, nodes.map((n) => n.payload)])
      ),
      null,
      2
    );

    const batchNodesJson = JSON.stringify(
      options.batchNodes.map((n, idx) => {
        const appContext = this.safeJsonParse<AppContextPayload>(n.appContext, {
          appHint: null,
          windowTitle: null,
          sourceKey: "",
        });
        const keywords = this.safeJsonParse<string[]>(n.keywords, []);
        const knowledge = this.safeJsonParse<KnowledgePayload | null>(n.knowledge, null);
        const stateSnapshot = this.safeJsonParse<StateSnapshotPayload | null>(
          n.stateSnapshot,
          null
        );
        const derivedEntities = this.extractDerivedEntities({
          keywords,
          knowledge,
          stateSnapshot,
        });

        return {
          node_index: idx,
          title: n.title,
          summary: n.summary,
          app_hint: appContext.appHint ?? null,
          keywords,
          entities: derivedEntities,
          event_time: n.eventTime,
          knowledge: knowledge ?? undefined,
          state_snapshot: stateSnapshot ?? undefined,
        };
      }),
      null,
      2
    );

    const timeContext = this.buildTimeContext(now);

    const userPrompt = promptTemplates.getThreadLlmUserPrompt({
      activeThreadsJson,
      threadRecentNodesJson,
      batchNodesJson,
      localTime: timeContext.localTime,
      timeZone: timeContext.timeZone,
      now: timeContext.now,
      nowTs: timeContext.nowTs,
      todayStart: timeContext.todayStart,
      todayEnd: timeContext.todayEnd,
      yesterdayStart: timeContext.yesterdayStart,
      yesterdayEnd: timeContext.yesterdayEnd,
      weekAgo: timeContext.weekAgo,
    });

    const aiService = AISDKService.getInstance();
    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    const release = await aiRuntimeService.acquire("text");
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);

    try {
      const { object, usage } = await generateObject({
        model: aiService.getTextClient(),
        schema: ThreadLLMOutputSchema,
        mode: "json",
        system: promptTemplates.getThreadLlmSystemPrompt(),
        messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
        abortSignal: controller.signal,
        providerOptions: {
          mnemora: {},
        },
      });

      const parsed = ThreadLLMOutputProcessedSchema.parse(object);
      const durationMs = Date.now() - startTime;

      await llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "thread_assign",
        status: "succeeded",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        totalTokens: usage?.totalTokens ?? 0,
        usageStatus: usage ? "present" : "missing",
      });

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "thread_assign",
        model: aiService.getTextModelName(),
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(parsed, null, 2),
      });

      aiRuntimeService.recordSuccess("text");

      return { output: parsed, activeThreadIds: activeThreads.map((t) => t.id) };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (NoObjectGeneratedError.isInstance(error)) {
        logger.error(
          {
            errorName: error.name,
            rawText: error.text,
            rawResponse: error.response,
            cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
          },
          "Thread LLM NoObjectGeneratedError - raw response did not match schema"
        );
      } else {
        logger.error({ error }, "Thread LLM request failed");
      }

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "thread_assign",
        model: aiService.getTextModelName(),
        durationMs,
        status: "failed",
        errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });

      await llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "thread_assign",
        status: "failed",
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        usageStatus: "missing",
      });

      aiRuntimeService.recordFailure("text", error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      release();
    }
  }

  private loadActiveThreads(db: ReturnType<typeof getDb>): ThreadRow[] {
    const base = db
      .select({
        id: threads.id,
        title: threads.title,
        summary: threads.summary,
        currentPhase: threads.currentPhase,
        currentFocus: threads.currentFocus,
        startTime: threads.startTime,
        lastActiveAt: threads.lastActiveAt,
        durationMs: threads.durationMs,
        nodeCount: threads.nodeCount,
        mainProject: threads.mainProject,
        status: threads.status,
      })
      .from(threads);

    const active = base
      .where(eq(threads.status, "active"))
      .orderBy(desc(threads.lastActiveAt))
      .limit(processingConfig.thread.maxActiveThreads)
      .all();

    if (active.length > 0) {
      return active;
    }

    return base
      .where(ne(threads.status, "closed"))
      .orderBy(desc(threads.lastActiveAt))
      .limit(processingConfig.thread.fallbackRecentThreads)
      .all();
  }

  private loadThreadRecentNodes(
    db: ReturnType<typeof getDb>,
    threadIds: string[]
  ): Array<[string, { nodeId: number; payload: unknown }[]]> {
    const out: Array<[string, { nodeId: number; payload: unknown }[]]> = [];

    for (const threadId of threadIds) {
      const rows = db
        .select({
          id: contextNodes.id,
          title: contextNodes.title,
          summary: contextNodes.summary,
          eventTime: contextNodes.eventTime,
          appContext: contextNodes.appContext,
          keywords: contextNodes.keywords,
          knowledge: contextNodes.knowledge,
          stateSnapshot: contextNodes.stateSnapshot,
        })
        .from(contextNodes)
        .where(eq(contextNodes.threadId, threadId))
        .orderBy(desc(contextNodes.eventTime))
        .limit(processingConfig.thread.recentNodesPerThread)
        .all();

      const nodes = rows
        .slice()
        .reverse()
        .map((r, idx) => {
          const appContext = this.safeJsonParse<AppContextPayload>(r.appContext, {
            appHint: null,
            windowTitle: null,
            sourceKey: "",
          });
          const keywords = this.safeJsonParse<string[]>(r.keywords, []);
          const knowledge = this.safeJsonParse<KnowledgePayload | null>(r.knowledge, null);
          const stateSnapshot = this.safeJsonParse<StateSnapshotPayload | null>(
            r.stateSnapshot,
            null
          );
          const derivedEntities = this.extractDerivedEntities({
            keywords,
            knowledge,
            stateSnapshot,
          });

          return {
            nodeId: r.id,
            payload: {
              node_index: idx,
              title: r.title,
              summary: r.summary,
              app_hint: appContext.appHint ?? null,
              keywords,
              entities: derivedEntities,
              event_time: r.eventTime,
              knowledge: knowledge ?? undefined,
              state_snapshot: stateSnapshot ?? undefined,
            },
          };
        });

      out.push([threadId, nodes]);
    }

    return out;
  }

  private safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private dedupeStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
      const s = (v ?? "").trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  private buildTimeContext(now: Date) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nowTs = now.getTime();

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayEnd = new Date(todayEnd.getTime() - 24 * 60 * 60 * 1000);

    const weekAgo = nowTs - 7 * 24 * 60 * 60 * 1000;

    return {
      localTime: now.toLocaleString("sv-SE", { timeZone, hour12: false }),
      timeZone,
      now,
      nowTs,
      todayStart: todayStart.getTime(),
      todayEnd: todayEnd.getTime(),
      yesterdayStart: yesterdayStart.getTime(),
      yesterdayEnd: yesterdayEnd.getTime(),
      weekAgo,
    };
  }

  private extractDerivedEntities(args: {
    keywords: string[];
    knowledge: KnowledgePayload | null;
    stateSnapshot: StateSnapshotPayload | null;
  }): string[] {
    return this.dedupeStrings([
      ...args.keywords,
      args.knowledge?.projectOrLibrary ?? null,
      args.stateSnapshot?.subject ?? null,
    ]);
  }
}

export const threadLlmService = new ThreadLlmService();
