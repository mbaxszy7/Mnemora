import { BrowserWindow } from "electron";
import { and, desc, eq, gte, lt, lte, gt, isNull, or } from "drizzle-orm";
import { generateObject } from "ai";
import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityStats,
  EventDetailsResponse,
  LongEventMarker,
  SummaryResponse,
  TimelineResponse,
  TimeWindow,
  WindowSummary,
} from "@shared/activity-types";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { getDb } from "../../database";
import {
  activityEvents,
  activitySummaries,
  contextNodes,
  type ActivityEventRecord,
  type ActivitySummaryRecord,
  type ContextNodeRecord,
} from "../../database/schema";
import { getLogger } from "../logger";
import { AISDKService } from "../ai-sdk-service";
import { llmUsageService } from "../llm-usage-service";
import { aiRuntimeService } from "../ai-runtime-service";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { activityAlertBuffer } from "../monitoring/activity-alert-trace";
import {
  ActivityEventDetailsLLMSchema,
  ActivityEventDetailsLLMProcessedSchema,
  ActivityWindowSummaryLLMSchema,
  ActivityWindowSummaryLLMProcessedSchema,
} from "./schemas";
import { processingConfig } from "./config";
import { promptTemplates } from "./prompt-templates";
import { screenshotProcessingEventBus } from "./event-bus";

const logger = getLogger("activity-monitor-service");

let activityTimelineChangedRevision = 0;
let activityTimelineChangedTimer: NodeJS.Timeout | null = null;
let activityTimelineChangedRange: { fromTs: number; toTs: number } | null = null;

function emitActivityTimelineChanged(fromTs: number, toTs: number): void {
  const nextFrom = Math.min(fromTs, activityTimelineChangedRange?.fromTs ?? fromTs);
  const nextTo = Math.max(toTs, activityTimelineChangedRange?.toTs ?? toTs);
  activityTimelineChangedRange = { fromTs: nextFrom, toTs: nextTo };

  if (activityTimelineChangedTimer) {
    return;
  }

  activityTimelineChangedTimer = setTimeout(() => {
    activityTimelineChangedTimer = null;
    const range = activityTimelineChangedRange;
    activityTimelineChangedRange = null;
    if (!range) return;

    activityTimelineChangedRevision += 1;
    const payload = {
      revision: activityTimelineChangedRevision,
      fromTs: range.fromTs,
      toTs: range.toTs,
    };

    screenshotProcessingEventBus.emit("activity-timeline:changed", {
      type: "activity-timeline:changed",
      timestamp: Date.now(),
      payload,
    });

    try {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC_CHANNELS.ACTIVITY_TIMELINE_CHANGED, payload);
      }
    } catch {
      // ignore when running in tests
    }
  }, 800);
}

function parseJsonSafe<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function capJsonArrayByChars<T>(
  items: T[],
  maxItems: number,
  maxChars: number
): { items: T[]; approxChars: number } {
  const result: T[] = [];
  let used = 2;

  for (const item of items) {
    if (result.length >= maxItems) break;
    const s = JSON.stringify(item);
    const additional = s.length + (result.length === 0 ? 0 : 1);
    if (used + additional > maxChars) break;
    used += additional;
    result.push(item);
  }

  return { items: result, approxChars: used };
}

function inferLongEventKindFromSnapshot(snapshot: {
  title?: string;
  currentPhase?: string;
}): ActivityEventKind {
  const phase = (snapshot.currentPhase ?? "").toLowerCase();
  const title = (snapshot.title ?? "").toLowerCase();
  const haystack = `${phase} ${title}`;

  if (haystack.includes("meeting")) return "meeting";
  if (haystack.includes("break")) return "break";
  if (haystack.includes("browse") || haystack.includes("research")) return "browse";
  if (haystack.includes("debug")) return "debugging";
  if (haystack.includes("code") || haystack.includes("implement")) return "coding";

  return "work";
}

function buildEmptyWindowSummary(): string {
  return [
    "## Core Tasks & Projects",
    "- None",
    "",
    "## Key Discussion & Decisions",
    "- None",
    "",
    "## Documents",
    "- None",
    "",
    "## Next Steps",
    "- None",
  ].join("\n");
}

function normalizeSummaryStatus(status: string): "pending" | "succeeded" | "failed" {
  if (status === "running") return "pending";
  if (status === "failed_permanent") return "failed";
  if (status === "failed") return "failed";
  if (status === "no_data") return "succeeded";
  if (status === "succeeded") return "succeeded";
  return "pending";
}

function normalizeDetailsStatus(status: string): "pending" | "succeeded" | "failed" {
  if (status === "running") return "pending";
  if (status === "failed_permanent") return "failed";
  if (status === "failed") return "failed";
  if (status === "succeeded") return "succeeded";
  return "pending";
}

function parseAppHint(node: ContextNodeRecord): string | null {
  const appContext = parseJsonSafe<{ appHint?: string } | null>(node.appContext, null);
  return typeof appContext?.appHint === "string" ? appContext.appHint : null;
}

function toSnakeCaseKnowledgePayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const textRegion = (obj.textRegion ?? obj.text_region) as Record<string, unknown> | undefined;

  return {
    content_type: obj.contentType ?? obj.content_type,
    source_url: obj.sourceUrl ?? obj.source_url,
    project_or_library: obj.projectOrLibrary ?? obj.project_or_library,
    key_insights: obj.keyInsights ?? obj.key_insights,
    language: obj.language,
    text_region: textRegion
      ? {
          box: (textRegion.box ?? (textRegion as Record<string, unknown>).box) as unknown,
          description: textRegion.description,
          confidence: textRegion.confidence,
        }
      : undefined,
  };
}

function toSnakeCaseStateSnapshotPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;

  return {
    subject_type: obj.subjectType ?? obj.subject_type,
    subject: obj.subject,
    current_state: obj.currentState ?? obj.current_state,
    metrics: obj.metrics,
    issue: obj.issue,
  };
}

function extractEntityNames(rawEntitiesJson: string | null | undefined): string[] {
  const entities = parseJsonSafe<Array<{ name?: unknown }>>(rawEntitiesJson, []);
  const out: string[] = [];
  for (const e of entities) {
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    if (!name) continue;
    out.push(name);
  }
  return out;
}

function buildTimeContext(now: Date) {
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

class ActivityMonitorService {
  async getTimeline(fromTs: number, toTs: number): Promise<TimelineResponse> {
    const db = getDb();

    const summaries = await db
      .select()
      .from(activitySummaries)
      .where(
        and(lte(activitySummaries.windowStart, toTs), gte(activitySummaries.windowEnd, fromTs))
      )
      .orderBy(desc(activitySummaries.windowStart));

    const windows: TimeWindow[] = summaries.map((s: ActivitySummaryRecord) => ({
      id: s.id,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      title: s.title,
      status: normalizeSummaryStatus(s.status),
      stats: parseJsonSafe<ActivityStats | null>(s.stats, null),
    }));

    const events = await db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.isLong, true),
          lt(activityEvents.startTs, toTs),
          gt(activityEvents.endTs, fromTs)
        )
      )
      .orderBy(desc(activityEvents.startTs));

    const longEvents: LongEventMarker[] = events.map((e: ActivityEventRecord) => ({
      id: e.id,
      title: e.title,
      kind: e.kind as ActivityEventKind,
      startTs: e.startTs,
      endTs: e.endTs,
      durationMs: e.durationMs,
    }));

    return { windows, longEvents };
  }

  async getSummary(windowStart: number, windowEnd: number): Promise<SummaryResponse | null> {
    const db = getDb();

    const summaries = await db
      .select()
      .from(activitySummaries)
      .where(
        and(
          eq(activitySummaries.windowStart, windowStart),
          eq(activitySummaries.windowEnd, windowEnd)
        )
      )
      .limit(1);

    if (summaries.length === 0) {
      return null;
    }

    const summary = summaries[0];
    const events = await db
      .select()
      .from(activityEvents)
      .where(and(lt(activityEvents.startTs, windowEnd), gt(activityEvents.endTs, windowStart)))
      .orderBy(activityEvents.startTs);

    const mappedEvents: ActivityEvent[] = events.map((e: ActivityEventRecord) => ({
      id: e.id,
      eventKey: e.eventKey,
      title: e.title,
      kind: e.kind as ActivityEventKind,
      startTs: e.startTs,
      endTs: e.endTs,
      durationMs: e.durationMs,
      isLong: e.isLong,
      confidence: e.confidence ?? 5,
      importance: e.importance ?? 5,
      threadId: e.threadId,
      nodeIds: parseJsonSafe<number[] | null>(e.nodeIds, null),
      details: e.detailsText ?? null,
      detailsStatus: normalizeDetailsStatus(e.detailsStatus),
    }));

    const response: WindowSummary = {
      windowStart: summary.windowStart,
      windowEnd: summary.windowEnd,
      title: summary.title,
      summary: summary.summaryText ?? "",
      highlights: parseJsonSafe<string[] | null>(summary.highlights, null),
      stats: parseJsonSafe<ActivityStats | null>(summary.stats, null),
      events: mappedEvents,
    };

    return response;
  }

  async getEventDetails(eventId: number): Promise<EventDetailsResponse> {
    const db = getDb();
    const row = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.id, eventId))
      .limit(1);

    if (row.length === 0) {
      throw new Error(`Event not found: ${eventId}`);
    }

    const event = row[0];

    const mapped = (): ActivityEvent => ({
      id: event.id,
      eventKey: event.eventKey,
      title: event.title,
      kind: event.kind as ActivityEventKind,
      startTs: event.startTs,
      endTs: event.endTs,
      durationMs: event.durationMs,
      isLong: event.isLong,
      confidence: event.confidence ?? 5,
      importance: event.importance ?? 5,
      threadId: event.threadId,
      nodeIds: parseJsonSafe<number[] | null>(event.nodeIds, null),
      details: event.detailsText ?? null,
      detailsStatus: normalizeDetailsStatus(event.detailsStatus),
    });

    if (!event.isLong) {
      return mapped();
    }

    if (event.detailsText) {
      return mapped();
    }

    if (event.detailsStatus === "failed_permanent") {
      return mapped();
    }

    try {
      await this.generateEventDetails(eventId);

      const refreshed = await db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.id, eventId))
        .limit(1);

      if (refreshed.length === 0) {
        throw new Error(`Event not found after generation: ${eventId}`);
      }

      const e = refreshed[0];
      return {
        id: e.id,
        eventKey: e.eventKey,
        title: e.title,
        kind: e.kind as ActivityEventKind,
        startTs: e.startTs,
        endTs: e.endTs,
        durationMs: e.durationMs,
        isLong: e.isLong,
        confidence: e.confidence ?? 5,
        importance: e.importance ?? 5,
        threadId: e.threadId,
        nodeIds: parseJsonSafe<number[] | null>(e.nodeIds, null),
        details: e.detailsText ?? null,
        detailsStatus: normalizeDetailsStatus(e.detailsStatus),
      };
    } catch (error) {
      logger.warn(
        { eventId, error: error instanceof Error ? error.message : String(error) },
        "Event details generation failed on-demand"
      );

      const failedEvent = await db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.id, eventId))
        .limit(1);

      if (failedEvent.length === 0) {
        throw new Error(`Event not found: ${eventId}`);
      }

      const f = failedEvent[0];
      return {
        id: f.id,
        eventKey: f.eventKey,
        title: f.title,
        kind: f.kind as ActivityEventKind,
        startTs: f.startTs,
        endTs: f.endTs,
        durationMs: f.durationMs,
        isLong: f.isLong,
        confidence: f.confidence ?? 5,
        importance: f.importance ?? 5,
        threadId: f.threadId,
        nodeIds: parseJsonSafe<number[] | null>(f.nodeIds, null),
        details: f.detailsText ?? null,
        detailsStatus: normalizeDetailsStatus(f.detailsStatus),
      };
    }
  }

  async generateWindowSummary(windowStart: number, windowEnd: number): Promise<boolean> {
    const db = getDb();
    const aiService = AISDKService.getInstance();

    if (!aiService.isInitialized()) {
      logger.warn("AI service not initialized, skipping summary generation");
      return false;
    }

    try {
      const summaryRow = db
        .select()
        .from(activitySummaries)
        .where(
          and(
            eq(activitySummaries.windowStart, windowStart),
            eq(activitySummaries.windowEnd, windowEnd)
          )
        )
        .limit(1)
        .get();

      const nodes = await db
        .select()
        .from(contextNodes)
        .where(and(gte(contextNodes.eventTime, windowStart), lt(contextNodes.eventTime, windowEnd)))
        .orderBy(contextNodes.eventTime);

      if (nodes.length === 0) {
        const emptySummary = buildEmptyWindowSummary();
        const stats: ActivityStats = {
          topApps: [],
          topEntities: [],
          nodeCount: 0,
          screenshotCount: 0,
          threadCount: 0,
        };
        await db
          .update(activitySummaries)
          .set({
            title: "No Data",
            summaryText: emptySummary,
            highlights: JSON.stringify([]),
            stats: JSON.stringify(stats),
            status: "no_data",
            updatedAt: Date.now(),
            nextRunAt: null,
          })
          .where(
            and(
              eq(activitySummaries.windowStart, windowStart),
              eq(activitySummaries.windowEnd, windowEnd)
            )
          )
          .run();
        emitActivityTimelineChanged(windowStart, windowEnd);
        return true;
      }

      const appCounts: Record<string, number> = {};
      const entityCounts: Record<string, number> = {};
      const threadIds = new Set<string>();

      for (const node of nodes) {
        const appHint = parseAppHint(node);
        if (appHint) {
          appCounts[appHint] = (appCounts[appHint] || 0) + 1;
        }
        if (node.threadId) {
          threadIds.add(node.threadId);
        }
        const entities = parseJsonSafe<Array<{ name?: unknown }>>(node.entities, []);
        for (const e of entities) {
          const name = typeof e?.name === "string" ? e.name : null;
          if (!name) continue;
          entityCounts[name] = (entityCounts[name] || 0) + 1;
        }
      }

      const topApps = Object.entries(appCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name);

      const topEntities = Object.entries(entityCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name);

      const nodesData = nodes.map((node) => ({
        node_id: node.id,
        title: node.title,
        summary: node.summary,
        app_hint: parseAppHint(node),
        thread_id: node.threadId ?? null,
        entities: extractEntityNames(node.entities),
        keywords: parseJsonSafe<string[]>(node.keywords, []),
        event_time: node.eventTime,
        importance: node.importance,
        knowledge_json: toSnakeCaseKnowledgePayload(parseJsonSafe(node.knowledge, null)),
        state_snapshot_json: toSnakeCaseStateSnapshotPayload(
          parseJsonSafe(node.stateSnapshot, null)
        ),
      }));

      const longThreadMap = new Map<
        string,
        {
          snapshot: {
            title?: string;
            summary?: string;
            durationMs?: number;
            startTime?: number;
            currentPhase?: string;
            mainProject?: string;
          } | null;
          lastActiveAt: number;
          nodeCount: number;
        }
      >();

      for (const node of nodes) {
        if (!node.threadId) continue;
        const snapshot = parseJsonSafe<{
          title?: string;
          summary?: string;
          durationMs?: number;
          startTime?: number;
          currentPhase?: string;
          mainProject?: string;
        } | null>(node.threadSnapshot, null);

        const existing = longThreadMap.get(node.threadId);
        const next = {
          snapshot: snapshot ?? existing?.snapshot ?? null,
          lastActiveAt: Math.max(existing?.lastActiveAt ?? 0, node.eventTime),
          nodeCount: (existing?.nodeCount ?? 0) + 1,
        };
        longThreadMap.set(node.threadId, next);
      }

      const longThreads = Array.from(longThreadMap.entries())
        .map(([threadId, data]) => ({ threadId, ...data }))
        .filter(
          (entry) =>
            (entry.snapshot?.durationMs ?? 0) >=
            processingConfig.activitySummary.longEventThresholdMs
        )
        .map((entry) => ({
          thread_id: entry.threadId,
          title: entry.snapshot?.title ?? "",
          summary: entry.snapshot?.summary ?? "",
          duration_ms: entry.snapshot?.durationMs ?? 0,
          start_time: entry.snapshot?.startTime ?? windowStart,
          last_active_at: entry.lastActiveAt,
          current_phase: entry.snapshot?.currentPhase,
          main_project: entry.snapshot?.mainProject,
          node_count_in_window: entry.nodeCount,
        }));

      const timeContext = buildTimeContext(new Date());
      const userPrompt = promptTemplates.getActivitySummaryUserPrompt({
        nowTs: timeContext.nowTs,
        todayStart: timeContext.todayStart,
        todayEnd: timeContext.todayEnd,
        yesterdayStart: timeContext.yesterdayStart,
        yesterdayEnd: timeContext.yesterdayEnd,
        weekAgo: timeContext.weekAgo,
        windowStart,
        windowEnd,
        windowStartLocal: new Date(windowStart).toLocaleString("sv-SE", {
          timeZone: timeContext.timeZone,
          hour12: false,
        }),
        windowEndLocal: new Date(windowEnd).toLocaleString("sv-SE", {
          timeZone: timeContext.timeZone,
          hour12: false,
        }),
        contextNodesJson: JSON.stringify(nodesData, null, 2),
        longThreadsJson: JSON.stringify(longThreads, null, 2),
        statsJson: JSON.stringify(
          {
            top_apps: topApps,
            top_entities: topEntities,
            thread_count: threadIds.size,
            node_count: nodes.length,
          },
          null,
          2
        ),
      });

      const releaseText = await aiRuntimeService.acquire("text");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);
      let llmResult: { object: unknown; usage?: { totalTokens?: number } };
      try {
        llmResult = await generateObject({
          model: aiService.getTextClient(),
          system: promptTemplates.getActivitySummarySystemPrompt(),
          schema: ActivityWindowSummaryLLMSchema,
          prompt: userPrompt,
          abortSignal: controller.signal,
          providerOptions: {
            mnemora: {
              thinking: {
                type: "disabled",
              },
            },
          },
        });
      } finally {
        clearTimeout(timeoutId);
        releaseText();
      }

      const { object: rawData, usage } = llmResult;
      const data = ActivityWindowSummaryLLMProcessedSchema.parse(rawData);

      aiRuntimeService.recordSuccess("text");
      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "text_summary",
        status: "succeeded",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        totalTokens: usage?.totalTokens ?? 0,
        usageStatus: usage ? "present" : "missing",
      });
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_summary",
        model: aiService.getTextModelName(),
        durationMs: Date.now() - windowStart,
        status: "succeeded",
        responsePreview: JSON.stringify(data, null, 2),
      });

      const finalStats: ActivityStats = {
        topApps,
        topEntities,
        nodeCount: nodes.length,
        screenshotCount: nodes.length,
        threadCount: threadIds.size,
      };

      await db
        .update(activitySummaries)
        .set({
          title: data.title,
          summaryText: data.summary,
          highlights: JSON.stringify(data.highlights),
          stats: JSON.stringify(finalStats),
          status: "succeeded",
          nextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(activitySummaries.windowStart, windowStart),
            eq(activitySummaries.windowEnd, windowEnd)
          )
        )
        .run();

      emitActivityTimelineChanged(windowStart, windowEnd);

      for (const [idx, event] of data.events.entries()) {
        const startTs = windowStart + event.startOffsetMin * 60 * 1000;
        const endTs = windowStart + event.endOffsetMin * 60 * 1000;
        const titleHash = Buffer.from(`${event.kind}:${event.title}`).toString("hex").slice(0, 16);
        const eventKey = `win_${windowStart}_evt_${idx}_${titleHash}`;

        await this.upsertEvent({
          eventKey,
          title: event.title,
          kind: event.kind,
          startTs,
          endTs,
          threadId: event.threadId ?? null,
          nodeIds: event.nodeIds,
          confidence: event.confidence,
          importance: event.importance,
          summaryId: summaryRow?.id ?? null,
        });
      }

      const kindByThreadId = new Map<string, ActivityEventKind>();
      for (const event of data.events) {
        if (!event.threadId) continue;
        kindByThreadId.set(event.threadId, event.kind as ActivityEventKind);
      }

      for (const thread of longThreads) {
        const threadId = thread.thread_id;
        const markerKey = `thr_${threadId}`;

        const latestNodeIds = await db
          .select({ id: contextNodes.id })
          .from(contextNodes)
          .where(eq(contextNodes.threadId, threadId))
          .orderBy(desc(contextNodes.eventTime))
          .limit(200);

        const nodeIdsJson = JSON.stringify(latestNodeIds.map((r) => r.id));

        const existingMarker = await db
          .select({ id: activityEvents.id })
          .from(activityEvents)
          .where(eq(activityEvents.eventKey, markerKey))
          .limit(1);

        const nowTs = Date.now();
        if (existingMarker.length > 0) {
          await db
            .update(activityEvents)
            .set({
              title: thread.title,
              startTs: thread.start_time,
              endTs: thread.last_active_at,
              durationMs: thread.duration_ms,
              isLong: true,
              threadId,
              nodeIds: nodeIdsJson,
              updatedAt: nowTs,
            })
            .where(eq(activityEvents.id, existingMarker[0].id))
            .run();
        } else {
          const kind =
            kindByThreadId.get(threadId) ??
            inferLongEventKindFromSnapshot({
              title: thread.title,
              currentPhase: thread.current_phase,
            });

          await db
            .insert(activityEvents)
            .values({
              eventKey: markerKey,
              title: thread.title,
              kind,
              startTs: thread.start_time,
              endTs: thread.last_active_at,
              durationMs: thread.duration_ms,
              isLong: true,
              confidence: 6,
              importance: 6,
              threadId,
              nodeIds: nodeIdsJson,
              detailsStatus: "pending",
              detailsAttempts: 0,
              createdAt: nowTs,
              updatedAt: nowTs,
            })
            .run();
        }
      }

      return true;
    } catch (error) {
      logger.error({ error, windowStart }, "Failed to generate window summary");
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (error instanceof Error && error.name === "AbortError") {
        activityAlertBuffer.record({
          ts: Date.now(),
          kind: "activity_summary_timeout",
          message: `Activity summary timed out after ${processingConfig.ai.textTimeoutMs}ms`,
          windowStart,
          windowEnd,
        });
      }

      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "text_summary",
        status: "failed",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        totalTokens: 0,
        usageStatus: "missing",
        errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_summary",
        model: aiService.getTextModelName(),
        durationMs: 0,
        status: "failed",
        errorPreview: errorMessage,
      });
      aiRuntimeService.recordFailure("text", error, { tripBreaker: false });

      await db
        .update(activitySummaries)
        .set({
          status: "failed",
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(activitySummaries.windowStart, windowStart),
            eq(activitySummaries.windowEnd, windowEnd)
          )
        )
        .run();

      emitActivityTimelineChanged(windowStart, windowEnd);
      return false;
    }
  }

  async generateEventDetails(eventId: number): Promise<boolean> {
    const db = getDb();
    const aiService = AISDKService.getInstance();

    if (!aiService.isInitialized()) {
      return false;
    }

    try {
      const startTime = Date.now();
      const eventRows = await db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.id, eventId))
        .limit(1);

      if (eventRows.length === 0) return false;
      const event = eventRows[0];

      const now = Date.now();
      const staleThreshold = now - processingConfig.scheduler.staleRunningThresholdMs;

      if (!event.isLong || !event.threadId) {
        return false;
      }

      const currentAttempts = event.detailsAttempts ?? 0;

      if (event.detailsStatus === "running") {
        if (event.updatedAt < staleThreshold) {
          await db
            .update(activityEvents)
            .set({
              detailsStatus: "failed",
              updatedAt: now,
            })
            .where(eq(activityEvents.id, eventId))
            .run();

          activityAlertBuffer.record({
            ts: now,
            kind: "activity_event_details_stuck_running",
            message: `Event details was stuck running for >${processingConfig.scheduler.staleRunningThresholdMs}ms; reset to failed`,
            eventId,
            updatedAt: event.updatedAt,
          });
        } else {
          return false;
        }
      }

      if (currentAttempts >= processingConfig.retry.maxAttempts) {
        await db
          .update(activityEvents)
          .set({
            detailsStatus: "failed_permanent",
            updatedAt: now,
          })
          .where(eq(activityEvents.id, eventId))
          .run();
        return false;
      }

      const nextAttempts = currentAttempts + 1;

      const claim = await db
        .update(activityEvents)
        .set({
          detailsStatus: "running",
          detailsAttempts: nextAttempts,
          detailsNextRunAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(activityEvents.id, eventId),
            isNull(activityEvents.detailsText),
            or(
              eq(activityEvents.detailsStatus, "pending"),
              eq(activityEvents.detailsStatus, "failed")
            ),
            eq(activityEvents.detailsAttempts, currentAttempts)
          )
        )
        .run();

      if (claim.changes === 0) {
        return false;
      }

      const nodeIds = parseJsonSafe<number[]>(event.nodeIds, []);
      if (nodeIds.length === 0) {
        await db
          .update(activityEvents)
          .set({
            detailsText: "No evidence found for this event.",
            detailsStatus: "succeeded",
            updatedAt: Date.now(),
          })
          .where(eq(activityEvents.id, eventId))
          .run();
        return true;
      }

      const windowNodesRows = await db
        .select()
        .from(contextNodes)
        .where(
          and(
            eq(contextNodes.threadId, event.threadId),
            gte(contextNodes.eventTime, event.startTs),
            lt(contextNodes.eventTime, event.endTs)
          )
        )
        .orderBy(contextNodes.eventTime);

      const latestNodesRows = await db
        .select()
        .from(contextNodes)
        .where(eq(contextNodes.threadId, event.threadId))
        .orderBy(desc(contextNodes.eventTime))
        .limit(processingConfig.activitySummary.eventDetailsEvidenceMaxNodes);

      const timeContext = buildTimeContext(new Date());

      const formatNodes = (rows: ContextNodeRecord[]) =>
        rows.map((node) => ({
          node_id: node.id,
          title: node.title,
          summary: node.summary,
          app_hint: parseAppHint(node),
          knowledge_json: toSnakeCaseKnowledgePayload(parseJsonSafe(node.knowledge, null)),
          state_snapshot_json: toSnakeCaseStateSnapshotPayload(
            parseJsonSafe(node.stateSnapshot, null)
          ),
          entities_json: parseJsonSafe(node.entities, []),
          action_items_json: null,
          event_time: node.eventTime,
          local_time: new Date(node.eventTime).toLocaleString("sv-SE", {
            timeZone: timeContext.timeZone,
            hour12: false,
          }),
          is_in_current_window: node.eventTime >= event.startTs && node.eventTime < event.endTs,
        }));

      const windowNodesRaw = formatNodes(windowNodesRows);
      const latestNodesRaw = formatNodes(latestNodesRows);

      const { items: windowNodes } = capJsonArrayByChars(
        windowNodesRaw,
        processingConfig.activitySummary.eventDetailsEvidenceMaxNodes,
        processingConfig.activitySummary.eventDetailsEvidenceMaxChars
      );
      const { items: threadLatestNodes } = capJsonArrayByChars(
        latestNodesRaw,
        processingConfig.activitySummary.eventDetailsEvidenceMaxNodes,
        processingConfig.activitySummary.eventDetailsEvidenceMaxChars
      );

      const latestSnapshot = latestNodesRows.find((row) => row.threadSnapshot)?.threadSnapshot;
      const snapshot = parseJsonSafe<{
        title?: string;
        summary?: string;
        durationMs?: number;
        startTime?: number;
        currentPhase?: string;
        mainProject?: string;
      }>(latestSnapshot, {});

      const userPromptPayload = {
        now_ts: timeContext.nowTs,
        today_start: timeContext.todayStart,
        today_end: timeContext.todayEnd,
        yesterday_start: timeContext.yesterdayStart,
        yesterday_end: timeContext.yesterdayEnd,
        week_ago: timeContext.weekAgo,
        event: {
          event_id: event.id,
          title: event.title,
          kind: event.kind,
          start_ts: event.startTs,
          end_ts: event.endTs,
          is_long: event.isLong,
        },
        thread: {
          thread_id: event.threadId,
          title: snapshot.title ?? "",
          summary: snapshot.summary ?? "",
          duration_ms: snapshot.durationMs ?? event.durationMs,
          start_time: snapshot.startTime ?? event.startTs,
          current_phase: snapshot.currentPhase,
          main_project: snapshot.mainProject,
        },
        window_nodes: windowNodes,
        thread_latest_nodes: threadLatestNodes,
      };

      const userPrompt = promptTemplates.getEventDetailsUserPrompt({
        userPromptJson: JSON.stringify(userPromptPayload, null, 2),
      });

      const releaseText = await aiRuntimeService.acquire("text");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);
      let llmResult: { object: unknown; usage?: { totalTokens?: number } };
      try {
        llmResult = await generateObject({
          model: aiService.getTextClient(),
          system: promptTemplates.getEventDetailsSystemPrompt(),
          schema: ActivityEventDetailsLLMSchema,
          prompt: userPrompt,
          abortSignal: controller.signal,
          providerOptions: {
            mnemora: {
              thinking: {
                type: "disabled",
              },
            },
          },
        });
      } finally {
        clearTimeout(timeoutId);
        releaseText();
      }

      const { object: rawData, usage } = llmResult;
      const data = ActivityEventDetailsLLMProcessedSchema.parse(rawData);

      aiRuntimeService.recordSuccess("text");
      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "text_event_details",
        status: "succeeded",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        totalTokens: usage?.totalTokens ?? 0,
        usageStatus: usage ? "present" : "missing",
      });
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_event_details",
        model: aiService.getTextModelName(),
        durationMs: Date.now() - startTime,
        status: "succeeded",
        responsePreview: JSON.stringify(data, null, 2),
      });

      await db
        .update(activityEvents)
        .set({
          detailsText: data.details,
          detailsStatus: "succeeded",
          updatedAt: Date.now(),
        })
        .where(eq(activityEvents.id, eventId))
        .run();

      emitActivityTimelineChanged(event.startTs, event.endTs);
      return true;
    } catch (error) {
      logger.error({ error, eventId }, "Failed to generate event details");

      if (error instanceof Error && error.name === "AbortError") {
        activityAlertBuffer.record({
          ts: Date.now(),
          kind: "activity_event_details_timeout",
          message: `Event details timed out after ${processingConfig.ai.textTimeoutMs}ms`,
          eventId,
        });
      }

      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "text_event_details",
        status: "failed",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        totalTokens: 0,
        usageStatus: "missing",
        errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_event_details",
        model: aiService.getTextModelName(),
        durationMs: 0,
        status: "failed",
        errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      aiRuntimeService.recordFailure("text", error, { tripBreaker: false });

      const row = await db
        .select({ detailsAttempts: activityEvents.detailsAttempts })
        .from(activityEvents)
        .where(eq(activityEvents.id, eventId))
        .limit(1);

      const attempts = row[0]?.detailsAttempts ?? 0;
      const exceeded = attempts >= processingConfig.retry.maxAttempts;
      const status = exceeded ? "failed_permanent" : "failed";

      await db
        .update(activityEvents)
        .set({
          detailsStatus: status,
          updatedAt: Date.now(),
        })
        .where(and(eq(activityEvents.id, eventId), eq(activityEvents.detailsStatus, "running")))
        .run();

      emitActivityTimelineChanged(Date.now() - 24 * 60 * 60 * 1000, Date.now());
      return false;
    }
  }

  async upsertEvent(params: {
    eventKey: string;
    title: string;
    kind: string;
    startTs: number;
    endTs: number;
    threadId?: string | null;
    nodeIds?: number[] | null;
    confidence?: number;
    importance?: number;
    summaryId?: number | null;
  }): Promise<number> {
    const db = getDb();
    const now = Date.now();
    const durationMs = params.endTs - params.startTs;
    const isLong = durationMs >= processingConfig.activitySummary.longEventThresholdMs;

    const existing = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventKey, params.eventKey))
      .limit(1);

    if (existing.length > 0) {
      const event = existing[0];
      const newStartTs = Math.min(event.startTs, params.startTs);
      const newEndTs = Math.max(event.endTs, params.endTs);
      const newDurationMs = newEndTs - newStartTs;
      const newIsLong = newDurationMs >= processingConfig.activitySummary.longEventThresholdMs;

      const existingNodeIds = parseJsonSafe<number[]>(event.nodeIds, []);
      const newNodeIds = params.nodeIds || [];
      const mergedNodeIds = [...new Set([...existingNodeIds, ...newNodeIds])];

      await db
        .update(activityEvents)
        .set({
          title: params.title,
          kind: params.kind,
          confidence: params.confidence ?? event.confidence,
          importance: params.importance ?? event.importance,
          threadId: params.threadId ?? event.threadId,
          summaryId: params.summaryId ?? event.summaryId,
          startTs: newStartTs,
          endTs: newEndTs,
          durationMs: newDurationMs,
          isLong: newIsLong,
          nodeIds: JSON.stringify(mergedNodeIds),
          updatedAt: now,
        })
        .where(eq(activityEvents.id, event.id))
        .run();

      return event.id;
    }

    const result = await db
      .insert(activityEvents)
      .values({
        eventKey: params.eventKey,
        title: params.title,
        kind: params.kind,
        startTs: params.startTs,
        endTs: params.endTs,
        durationMs,
        isLong,
        confidence: params.confidence ?? 5,
        importance: params.importance ?? 5,
        threadId: params.threadId ?? null,
        summaryId: params.summaryId ?? null,
        nodeIds: params.nodeIds ? JSON.stringify(params.nodeIds) : null,
        detailsStatus: "pending",
        detailsAttempts: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return Number(result.lastInsertRowid);
  }
}

export const activityMonitorService = new ActivityMonitorService();
