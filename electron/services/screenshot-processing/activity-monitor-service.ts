/**
 * Activity Monitor Service
 *
 * Provides timeline queries, window summaries, and event details for Activity Monitor.
 * Note: This is a data access layer - LLM generation is handled by ReconcileLoop.
 */

import { eq, and, or, gte, lte, ne, inArray, lt, gt, desc } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDb } from "../../database";
import {
  activitySummaries,
  activityEvents,
  type ActivitySummaryRecord,
  type ActivityEventRecord,
  contextNodes,
  type ContextNodeRecord,
  screenshots,
  contextScreenshotLinks,
} from "../../database/schema";
import type {
  TimeWindow,
  ActivityEvent,
  WindowSummary,
  LongEventMarker,
  TimelineResponse,
  ActivityStats,
  ActivityEventKind,
  ActivityTimelineChangedPayload,
} from "@shared/activity-types";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { getLogger } from "../logger";
import { AISDKService } from "../ai-sdk-service";
import { llmUsageService } from "../usage/llm-usage-service";
import { generateObject } from "ai";
import {
  ActivityWindowSummaryLLMSchema,
  ActivityWindowSummaryLLMProcessedSchema,
  ActivityEventDetailsLLMSchema,
  ActivityEventDetailsLLMProcessedSchema,
} from "./schemas";

import { activitySummaryConfig, retryConfig, aiConcurrencyConfig } from "./config";
import { aiFailureCircuitBreaker } from "../ai-failure-circuit-breaker";
import { aiSemaphore } from "./ai-semaphore";
import { promptTemplates } from "./prompt-templates";
import { aiConcurrencyTuner } from "./ai-concurrency-tuner";
import { mainI18n } from "../i18n-service";

const logger = getLogger("activity-monitor-service");

// 20 minutes threshold for long events
const LONG_EVENT_THRESHOLD_MS = 20 * 60 * 1000;

const EVENT_DETAILS_EVIDENCE_MAX_NODES = 50;
const EVENT_DETAILS_EVIDENCE_MAX_CHARS = 24000;
const EVENT_DETAILS_NODE_TITLE_MAX_CHARS = 220;
const EVENT_DETAILS_NODE_SUMMARY_MAX_CHARS = 900;

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
    const payload: ActivityTimelineChangedPayload = {
      revision: activityTimelineChangedRevision,
      fromTs: range.fromTs,
      toTs: range.toTs,
    };

    try {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC_CHANNELS.ACTIVITY_TIMELINE_CHANGED, payload);
      }
    } catch {
      // Ignore if BrowserWindow is not available (e.g. tests)
    }
  }, 800);
}

/**
 * Parse JSON safely with fallback
 */
function parseJsonSafe<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function truncateText(value: string | null | undefined, maxChars: number): string {
  const v = value ?? "";
  if (v.length <= maxChars) return v;
  return `${v.slice(0, Math.max(0, maxChars - 12))}...(truncated)`;
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
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "pending";
}

function normalizeDetailsStatus(status: string): "pending" | "succeeded" | "failed" {
  if (status === "running") return "pending";
  if (status === "failed_permanent") return "failed";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "pending";
}

class ActivityMonitorService {
  /**
   * Get timeline windows and long events for a time range
   */
  async getTimeline(fromTs: number, toTs: number): Promise<TimelineResponse> {
    const db = getDb();

    // Query activity summaries that overlap with the range
    const summaries = await db
      .select()
      .from(activitySummaries)
      .where(
        and(lte(activitySummaries.windowStart, toTs), gte(activitySummaries.windowEnd, fromTs))
      )
      .orderBy(desc(activitySummaries.windowStart));

    // Map to TimeWindow format
    const windows: TimeWindow[] = summaries.map((s: ActivitySummaryRecord) => ({
      id: s.id,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      title: s.title,
      status: normalizeSummaryStatus(s.status),
      stats: parseJsonSafe<ActivityStats | null>(s.stats, null),
    }));

    // Query long events that overlap with the range
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

    // Map to LongEventMarker format
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

  /**
   * Get a summary for a specific window
   */
  async getSummary(windowStart: number, windowEnd: number): Promise<WindowSummary | null> {
    const db = getDb();

    // Query the summary for this window
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

    // Query events that overlap with this window
    const events = await db
      .select()
      .from(activityEvents)
      .where(and(lt(activityEvents.startTs, windowEnd), gt(activityEvents.endTs, windowStart)))
      .orderBy(activityEvents.startTs);

    // Map events to ActivityEvent format
    const mappedEvents: ActivityEvent[] = events.map((e: ActivityEventRecord) => ({
      id: e.id,
      eventKey: e.eventKey,
      title: e.title,
      kind: e.kind as ActivityEventKind,
      startTs: e.startTs,
      endTs: e.endTs,
      durationMs: e.durationMs,
      isLong: e.isLong,
      confidence: e.confidence,
      importance: e.importance,
      threadId: e.threadId,
      nodeIds: parseJsonSafe<number[] | null>(e.nodeIds, null),
      details: e.details,
      detailsStatus: normalizeDetailsStatus(e.detailsStatus),
    }));

    return {
      windowStart: summary.windowStart,
      windowEnd: summary.windowEnd,
      title: summary.title,
      summary: summary.summary,
      highlights: parseJsonSafe<string[] | null>(summary.highlights, null),
      stats: parseJsonSafe<ActivityStats | null>(summary.stats, null),
      events: mappedEvents,
    };
  }

  /**
   * Get event details. If details are missing for a long event, trigger background generation
   */
  async getEventDetails(eventId: number): Promise<ActivityEvent> {
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
      confidence: event.confidence,
      importance: event.importance,
      threadId: event.threadId,
      nodeIds: parseJsonSafe<number[] | null>(event.nodeIds, null),
      details: event.details,
      detailsStatus: normalizeDetailsStatus(event.detailsStatus),
    });

    // Non-long events don't need details
    if (!event.isLong) {
      return mapped();
    }

    // Already have details
    if (event.details) {
      return mapped();
    }

    // Details generation failed permanently
    if (event.detailsStatus === "failed_permanent") {
      return mapped();
    }

    // Directly generate details for on-demand user request
    // This bypasses the scheduler for immediate response
    try {
      await this.generateEventDetails(eventId);

      // Fetch refreshed event with details
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
        confidence: e.confidence,
        importance: e.importance,
        threadId: e.threadId,
        nodeIds: parseJsonSafe<number[] | null>(e.nodeIds, null),
        details: e.details,
        detailsStatus: normalizeDetailsStatus(e.detailsStatus),
      };
    } catch (error) {
      // If generation fails, return event with failed status
      logger.warn(
        { eventId, error: error instanceof Error ? error.message : String(error) },
        "Event details generation failed on-demand"
      );

      // Refetch to get latest status
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
        confidence: f.confidence,
        importance: f.importance,
        threadId: f.threadId,
        nodeIds: parseJsonSafe<number[] | null>(f.nodeIds, null),
        details: f.details,
        detailsStatus: normalizeDetailsStatus(f.detailsStatus),
      };
    }
  }

  /**
   * Trigger LLM generation for a 20-minute window summary
   */
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

      // Count screenshots in window (no storageState filter per user)
      const screenshotCount = db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(and(gte(screenshots.ts, windowStart), lt(screenshots.ts, windowEnd)))
        .all().length;

      // 1. Fetch context nodes with their linked screenshots in this window
      // We use a left join to context_screenshot_links and screenshots to get app hints
      const rows = await db
        .select({
          node: contextNodes,
          screenshot: screenshots,
        })
        .from(contextNodes)
        .leftJoin(contextScreenshotLinks, eq(contextNodes.id, contextScreenshotLinks.nodeId))
        .leftJoin(screenshots, eq(contextScreenshotLinks.screenshotId, screenshots.id))
        .where(
          and(
            gte(contextNodes.eventTime, windowStart),
            lt(contextNodes.eventTime, windowEnd),
            ne(contextNodes.kind, "entity_profile")
          )
        )
        .orderBy(contextNodes.eventTime);

      const nodeIdsSet = new Set<number>();
      for (const row of rows) {
        nodeIdsSet.add(row.node.id);
      }
      const nodeCount = nodeIdsSet.size;

      // Branch: No Data (no screenshots at all)
      if (screenshotCount === 0) {
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
            summary: emptySummary,
            highlights: JSON.stringify([]),
            stats: JSON.stringify(stats),
            status: "succeeded",
            updatedAt: Date.now(),
            nextRunAt: null,
            errorCode: null,
            errorMessage: null,
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

      // Branch: Processing (screens exist but no nodes yet)
      if (screenshotCount > 0 && nodeCount === 0) {
        // Check if VLM is still working on these screenshots (pending, running, or failed-with-retries)
        const pendingVlmCount = db
          .select({ id: screenshots.id })
          .from(screenshots)
          .where(
            and(
              gte(screenshots.ts, windowStart),
              lt(screenshots.ts, windowEnd),
              or(
                inArray(screenshots.vlmStatus, ["pending", "running"]),
                and(
                  eq(screenshots.vlmStatus, "failed"),
                  lt(screenshots.vlmAttempts, retryConfig.maxAttempts)
                )
              )
            )
          )
          .all().length;

        const attempts = summaryRow?.attempts ?? 0;
        const nextRunAt = Date.now() + 5 * 60 * 1000;

        // If we are just waiting for VLM, don't count this as a failure attempt.
        // The scheduler already incremented it when claiming; roll it back only while VLM is still processing.
        const newAttempts = pendingVlmCount > 0 ? Math.max(0, attempts - 1) : attempts;

        // Only stop retries if we've exhausted attempts AND VLM has finished processing all screens
        const shouldStopRetry = newAttempts >= retryConfig.maxAttempts && pendingVlmCount === 0;

        const emptySummary = buildEmptyWindowSummary();
        const stats: ActivityStats = {
          topApps: [],
          topEntities: [],
          nodeCount: 0,
          screenshotCount,
          threadCount: 0,
        };
        await db
          .update(activitySummaries)
          .set({
            title: shouldStopRetry ? "No Data" : "Processing",
            summary: emptySummary,
            highlights: JSON.stringify([]),
            stats: JSON.stringify(stats),
            status: shouldStopRetry ? "succeeded" : "pending",
            attempts: newAttempts,
            nextRunAt: shouldStopRetry ? null : nextRunAt,
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
        // Return true to indicate we've handled the state (even if it's still 'pending')
        // Returning false would trigger the scheduler's catch block, which we want to avoid.
        return true;
      }

      // Group nodes and count unique screenshots
      const nodeMap = new Map<
        number,
        { node: ContextNodeRecord; apps: Set<string>; screenshotIds: Set<number> }
      >();
      for (const row of rows) {
        let entry = nodeMap.get(row.node.id);
        if (!entry) {
          entry = { node: row.node, apps: new Set<string>(), screenshotIds: new Set<number>() };
          nodeMap.set(row.node.id, entry);
        }
        if (row.screenshot?.appHint) {
          entry.apps.add(row.screenshot.appHint);
        }
        if (row.screenshot?.id) {
          entry.screenshotIds.add(row.screenshot.id);
        }
      }

      const nodes = Array.from(nodeMap.values());

      // 2. Aggregate stats for the prompt
      const appCounts: Record<string, number> = {};
      const entityCounts: Record<string, number> = {};
      const threadIds = new Set<string>();

      let totalScreenshotCount = 0;
      for (const { node, apps, screenshotIds } of nodes) {
        for (const app of apps) {
          appCounts[app] = (appCounts[app] || 0) + 1;
        }
        totalScreenshotCount += screenshotIds.size;
        if (node.threadId) threadIds.add(node.threadId);
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
        .map(([name]: [string, number]) => name);

      const topEntities = Object.entries(entityCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]: [string, number]) => name);

      // 3. Prepare nodes data for LLM
      const nodesData = nodes.map(
        ({ node, apps }: { node: ContextNodeRecord; apps: Set<string> }) => ({
          id: node.id,
          kind: node.kind,
          title: node.title,
          summary: node.summary,
          apps: Array.from(apps),
          time: node.eventTime ? new Date(node.eventTime).toLocaleTimeString() : "unknown",
        })
      );

      // 4. Prompt Design
      // System prompt is now handled by promptTemplates.getActivitySummarySystemPrompt()

      const userPrompt = JSON.stringify(
        {
          window: {
            windowStart,
            windowEnd,
          },
          contextNodes: nodesData,
          stats: {
            topApps,
            topEntities,
            nodeCount: nodes.length,
            screenshotCount: totalScreenshotCount,
            threadCount: threadIds.size,
          },
          outputSchema: {
            title: "string",
            summary: "string",
            highlights: "string[]",
            stats: { top_apps: "string[]", top_entities: "string[]" },
            events: [
              {
                title: "string",
                kind: "focus|work|meeting|break|browse|coding",
                start_offset_min: "number",
                end_offset_min: "number",
                confidence: "0-10",
                importance: "0-10",
                description: "string",
                node_ids: "number[]",
              },
            ],
          },
        },
        null,
        2
      );

      // Use semaphore for concurrency control and AbortController for timeout
      const releaseText = await aiSemaphore.text.acquire();
      let llmResult: { object: unknown; usage?: { totalTokens?: number } };
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), aiConcurrencyConfig.textTimeoutMs);
        try {
          llmResult = await generateObject({
            model: aiService.getTextClient(),
            system: promptTemplates.getActivitySummarySystemPrompt(),
            schema: ActivityWindowSummaryLLMSchema,
            prompt: promptTemplates.getActivitySummaryUserPrompt({
              userPromptJson: userPrompt,
              windowStart,
              windowEnd,
            }),
            abortSignal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
      } finally {
        releaseText();
      }

      const { object: rawData, usage } = llmResult;
      const data = ActivityWindowSummaryLLMProcessedSchema.parse(rawData);

      aiConcurrencyTuner.recordSuccess("text");

      // Log usage
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

      if (!data) {
        throw new Error("LLM output validation failed: null result from generateObject");
      }

      // 5. Save Summary
      const finalStats: ActivityStats = {
        topApps,
        topEntities,
        nodeCount: nodes.length,
        screenshotCount: totalScreenshotCount,
        threadCount: threadIds.size,
      };

      await db
        .update(activitySummaries)
        .set({
          title: data.title,
          summary: data.summary,
          highlights: JSON.stringify(data.highlights),
          stats: JSON.stringify(finalStats),
          status: "succeeded",
          nextRunAt: null,
          errorCode: null,
          errorMessage: null,
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

      // 6. Save Events
      const mergeGapMs = activitySummaryConfig.generationIntervalMs + 5 * 60 * 1000;
      for (const [idx, event] of data.events.entries()) {
        // Calculate absolute timestamps from offsets
        const startTs = windowStart + event.start_offset_min * 60 * 1000;
        const endTs = windowStart + event.end_offset_min * 60 * 1000;

        // Use threadId of the first node cited if available, or generate a stable key
        const primaryNodeId = event.node_ids[0];
        const primaryNodeEntry = nodes.find(
          (n: { node: ContextNodeRecord; apps: Set<string> }) => n.node.id === primaryNodeId
        );
        const threadId = primaryNodeEntry?.node.threadId || null;

        // Choose a stable eventKey. If a thread exists, try to merge across windows by continuity.
        let eventKey: string;
        if (threadId) {
          const candidate = await db
            .select({
              id: activityEvents.id,
              eventKey: activityEvents.eventKey,
              endTs: activityEvents.endTs,
              title: activityEvents.title,
              kind: activityEvents.kind,
            })
            .from(activityEvents)
            .where(
              and(
                eq(activityEvents.threadId, threadId),
                lte(activityEvents.startTs, startTs),
                gte(activityEvents.endTs, startTs - mergeGapMs)
              )
            )
            .orderBy(desc(activityEvents.endTs))
            .limit(1);

          const titleHash = Buffer.from(`${event.kind}:${event.title}`)
            .toString("hex")
            .slice(0, 16);
          if (candidate.length > 0) {
            eventKey = candidate[0].eventKey;
          } else {
            eventKey = `thr_${threadId}_win_${windowStart}_evt_${idx}_${titleHash}`;
          }
        } else {
          const titleHash = Buffer.from(`${event.kind}:${event.title}`)
            .toString("hex")
            .slice(0, 16);
          eventKey = `win_${windowStart}_evt_${idx}_${titleHash}`;
        }

        await this.upsertEvent({
          eventKey,
          title: event.title,
          kind: event.kind,
          startTs,
          endTs,
          threadId,
          nodeIds: event.node_ids,
          confidence: event.confidence,
          importance: event.importance,
        });
      }

      return true;
    } catch (error) {
      logger.error({ error, windowStart }, "Failed to generate window summary");
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log failure
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

      // Record failure for circuit breaker
      aiFailureCircuitBreaker.recordFailure("text", error);

      aiConcurrencyTuner.recordFailure("text", error);

      await db
        .update(activitySummaries)
        .set({
          status: "failed",
          errorMessage,
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

  /**
   * Generate detailed report for a long event
   */
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

      const dataFetchStart = Date.now();

      const nodeIds = parseJsonSafe<number[]>(event.nodeIds, []);
      if (nodeIds.length === 0) {
        await db
          .update(activityEvents)
          .set({
            details: "No evidence found for this event.",
            detailsStatus: "succeeded",
            updatedAt: Date.now(),
          })
          .where(eq(activityEvents.id, eventId))
          .run();
        return true;
      }

      // Fetch nodes with joined screens
      const rows = await db
        .select({
          node: contextNodes,
          screenshot: screenshots,
        })
        .from(contextNodes)
        .leftJoin(contextScreenshotLinks, eq(contextNodes.id, contextScreenshotLinks.nodeId))
        .leftJoin(screenshots, eq(contextScreenshotLinks.screenshotId, screenshots.id))
        .where(inArray(contextNodes.id, nodeIds));

      const nodeMap = new Map<number, { node: ContextNodeRecord; apps: Set<string> }>();
      for (const row of rows) {
        let entry = nodeMap.get(row.node.id);
        if (!entry) {
          entry = { node: row.node, apps: new Set<string>() };
          nodeMap.set(row.node.id, entry);
        }
        if (row.screenshot?.appHint) {
          entry.apps.add(row.screenshot.appHint);
        }
      }

      const nodesDataRaw = Array.from(nodeMap.values())
        .map(({ node, apps }: { node: ContextNodeRecord; apps: Set<string> }) => ({
          id: node.id,
          kind: node.kind,
          title: truncateText(node.title, EVENT_DETAILS_NODE_TITLE_MAX_CHARS),
          summary: truncateText(node.summary, EVENT_DETAILS_NODE_SUMMARY_MAX_CHARS),
          apps: Array.from(apps),
          eventTimeMs: node.eventTime ?? null,
        }))
        .sort((a, b) => {
          const at = a.eventTimeMs ?? 0;
          const bt = b.eventTimeMs ?? 0;
          return at - bt;
        });

      const { items: nodesDataCapped, approxChars: nodesDataApproxChars } = capJsonArrayByChars(
        nodesDataRaw,
        EVENT_DETAILS_EVIDENCE_MAX_NODES,
        EVENT_DETAILS_EVIDENCE_MAX_CHARS
      );

      const nodesData = nodesDataCapped.map(({ eventTimeMs, ...rest }) => ({
        ...rest,
        time: eventTimeMs ? new Date(eventTimeMs).toLocaleString() : "unknown",
      }));

      const dataFetchDuration = Date.now() - dataFetchStart;
      logger.debug(
        { eventId, nodeCount: nodeMap.size, durationMs: dataFetchDuration },
        "Event details data fetch completed"
      );

      // System prompt is now handled by promptTemplates.getEventDetailsSystemPrompt()

      const userPrompt = JSON.stringify(
        {
          event: {
            id: event.id,
            title: event.title,
            kind: event.kind,
            startTs: event.startTs,
            endTs: event.endTs,
            durationMinutes: Math.round(event.durationMs / 60000),
          },
          evidenceInfo: {
            originalNodeCount: nodeMap.size,
            returnedNodeCount: nodesData.length,
            returnedApproxChars: nodesDataApproxChars,
            maxNodes: EVENT_DETAILS_EVIDENCE_MAX_NODES,
            maxChars: EVENT_DETAILS_EVIDENCE_MAX_CHARS,
          },
          activityLogs: nodesData,
          outputSchema: {
            details:
              mainI18n.getCurrentLanguage() === "zh-CN" ? "markdown 字符串" : "markdown string",
          },
        },
        null,
        2
      );

      // Use semaphore for concurrency control and AbortController for timeout
      const aiStart = Date.now();
      const releaseText = await aiSemaphore.text.acquire();
      const semaphoreWaitDuration = Date.now() - aiStart;
      logger.debug({ eventId, waitMs: semaphoreWaitDuration }, "Event details semaphore acquired");

      let llmResult: { object: unknown; usage?: { totalTokens?: number } };
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), aiConcurrencyConfig.textTimeoutMs);
        try {
          llmResult = await generateObject({
            model: aiService.getTextClient(),
            system: promptTemplates.getEventDetailsSystemPrompt(),
            schema: ActivityEventDetailsLLMSchema,
            prompt: promptTemplates.getEventDetailsUserPrompt({
              userPromptJson: userPrompt,
            }),
            abortSignal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
      } finally {
        releaseText();
      }

      const aiDuration = Date.now() - aiStart;
      logger.info({ eventId, aiDurationMs: aiDuration }, "Event details AI generation completed");

      const { object: rawData, usage } = llmResult;
      const data = ActivityEventDetailsLLMProcessedSchema.parse(rawData);

      aiConcurrencyTuner.recordSuccess("text");

      // Log usage
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

      if (!data) {
        throw new Error("LLM output validation failed: null result from generateObject");
      }

      await db
        .update(activityEvents)
        .set({
          details: data.details,
          detailsStatus: "succeeded",
          updatedAt: Date.now(),
        })
        .where(eq(activityEvents.id, eventId))
        .run();

      emitActivityTimelineChanged(event.startTs, event.endTs);

      const totalDuration = Date.now() - startTime;
      logger.info(
        { eventId, totalDurationMs: totalDuration },
        "Event details updated successfully"
      );

      return true;
    } catch (error) {
      logger.error({ error, eventId }, "Failed to generate event details");

      // Log failure
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

      // Record failure for circuit breaker
      aiFailureCircuitBreaker.recordFailure("text", error);

      aiConcurrencyTuner.recordFailure("text", error);

      await db
        .update(activityEvents)
        .set({
          detailsStatus: "failed",
          detailsErrorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(activityEvents.id, eventId))
        .run();

      emitActivityTimelineChanged(Date.now() - 24 * 60 * 60 * 1000, Date.now());
      return false;
    }
  }

  /**
   * Create or update an event with isLong calculated from durationMs
   * Used by summary generation when processing LLM output
   */
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
  }): Promise<number> {
    const db = getDb();
    const now = Date.now();
    const durationMs = params.endTs - params.startTs;
    const isLong = durationMs >= LONG_EVENT_THRESHOLD_MS;

    // Check if event exists
    const existing = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventKey, params.eventKey))
      .limit(1);

    if (existing.length > 0) {
      // Update existing event
      const event = existing[0];
      const newStartTs = Math.min(event.startTs, params.startTs);
      const newEndTs = Math.max(event.endTs, params.endTs);
      const newDurationMs = newEndTs - newStartTs;
      const newIsLong = newDurationMs >= LONG_EVENT_THRESHOLD_MS;

      // Merge nodeIds
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
    } else {
      // Insert new event
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
          threadId: params.threadId || null,
          nodeIds: params.nodeIds ? JSON.stringify(params.nodeIds) : null,
          detailsStatus: "succeeded",
          detailsAttempts: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return Number(result.lastInsertRowid);
    }
  }
}

export const activityMonitorService = new ActivityMonitorService();
