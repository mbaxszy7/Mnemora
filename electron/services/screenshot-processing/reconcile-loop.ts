import { eq, and, or, lt, isNull, lte, desc, ne, inArray, asc, isNotNull } from "drizzle-orm";
import { getDb } from "../../database";
import {
  batches,
  contextNodes,
  screenshots,
  vectorDocuments,
  activitySummaries,
  activityEvents,
} from "../../database/schema";
import { getLogger } from "../logger";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "../screen-capture/types";
import {
  batchConfig,
  evidenceConfig,
  reconcileConfig,
  retryConfig,
  vectorStoreConfig,
  activitySummaryConfig,
} from "./config";
import { batchBuilder } from "./batch-builder";
import { contextGraphService } from "./context-graph-service";
import { vectorDocumentService } from "./vector-document-service";
import { entityService } from "./entity-service";
import { expandVLMIndexToNodes, textLLMProcessor } from "./text-llm-processor";

import { runVlmOnBatch } from "./vlm-processor";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";
import { activityMonitorService } from "./activity-monitor-service";

import type { VLMIndexResult } from "./schemas";
import type {
  AcceptedScreenshot,
  Batch,
  DetectedEntity,
  ExpandedContextNode,
  HistoryPack,
  PendingRecord,
  Shard,
  SourceKey,
} from "./types";
import type { ContextNodeRecord } from "../../database/schema";

const logger = getLogger("reconcile-loop");
const IDLE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

function getCanonicalAppCandidates(): string[] {
  return Object.keys(DEFAULT_WINDOW_FILTER_CONFIG.appAliases);
}

/**
 * ReconcileLoop orchestrates background tasks like node merging and embedding generation.
 * It ensures the system eventually reaches a consistent state by retrying failed operations
 * and recovering from crashes using SQLite status fields.
 */
export class ReconcileLoop {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private wakeScheduled = false;
  private wakeRequested = false;

  private captureActive = false;
  private captureActiveSince: number | null = null;
  private lastActivitySeedAt = 0;

  setCaptureActive(active: boolean, ts = Date.now()): void {
    const prev = this.captureActive;
    this.captureActive = active;
    if (active && !this.captureActiveSince) {
      this.captureActiveSince = ts;
    }
    if (!active) {
      this.captureActiveSince = null;
    }
    if (prev !== active) {
      this.wake();
    }
  }

  private alignToWindowStart(ts: number, intervalMs: number): number {
    const d = new Date(ts);
    d.setSeconds(0, 0);
    const mins = d.getMinutes();
    const intervalMinutes = Math.max(1, Math.round(intervalMs / 60000));
    const alignedMins = Math.floor(mins / intervalMinutes) * intervalMinutes;
    d.setMinutes(alignedMins);
    return d.getTime();
  }

  /**
   * Start the reconcile loop
   */
  start(): void {
    if (!reconcileConfig.enabled) {
      logger.info("Reconcile loop disabled by config");
      return;
    }
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Reconcile loop started");

    this.wake();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.isRunning) {
      return;
    }

    this.clearTimer();

    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : IDLE_SCAN_INTERVAL_MS;
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
  }

  private computeNextRunAt(now: number): number | null {
    const db = getDb();
    let next: number | null = null;

    const consider = (candidate: number | null | undefined): void => {
      if (candidate == null) return;
      if (next == null || candidate < next) {
        next = candidate;
      }
    };

    const batch = db
      .select({ nextRunAt: batches.nextRunAt })
      .from(batches)
      .where(
        and(
          or(eq(batches.status, "pending"), eq(batches.status, "failed")),
          lt(batches.attempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(batches.nextRunAt))
      .limit(1)
      .get();
    if (batch) {
      consider(batch.nextRunAt ?? now);
    }

    const merge = db
      .select({ nextRunAt: contextNodes.mergeNextRunAt })
      .from(contextNodes)
      .where(
        and(
          or(eq(contextNodes.mergeStatus, "pending"), eq(contextNodes.mergeStatus, "failed")),
          lt(contextNodes.mergeAttempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(contextNodes.mergeNextRunAt))
      .limit(1)
      .get();
    if (merge) {
      consider(merge.nextRunAt ?? now);
    }

    const embedding = db
      .select({ nextRunAt: vectorDocuments.embeddingNextRunAt })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          lt(vectorDocuments.embeddingAttempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(vectorDocuments.embeddingNextRunAt))
      .limit(1)
      .get();
    if (embedding) {
      consider(embedding.nextRunAt ?? now);
    }

    const index = db
      .select({ nextRunAt: vectorDocuments.indexNextRunAt })
      .from(vectorDocuments)
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          lt(vectorDocuments.indexAttempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(vectorDocuments.indexNextRunAt))
      .limit(1)
      .get();
    if (index) {
      consider(index.nextRunAt ?? now);
    }

    const summary = db
      .select({ nextRunAt: activitySummaries.nextRunAt })
      .from(activitySummaries)
      .where(
        and(
          or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed")),
          lt(activitySummaries.attempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(activitySummaries.nextRunAt))
      .limit(1)
      .get();
    if (summary) {
      consider(summary.nextRunAt ?? now);
    }

    const eventDetails = db
      .select({ nextRunAt: activityEvents.detailsNextRunAt })
      .from(activityEvents)
      .where(
        and(
          or(
            eq(activityEvents.detailsStatus, "pending"),
            eq(activityEvents.detailsStatus, "failed")
          ),
          lt(activityEvents.detailsAttempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(activityEvents.detailsNextRunAt))
      .limit(1)
      .get();
    if (eventDetails) {
      consider(eventDetails.nextRunAt ?? now);
    }

    const orphan = db
      .select({ createdAt: screenshots.createdAt })
      .from(screenshots)
      .where(
        and(
          isNull(screenshots.enqueuedBatchId),
          or(eq(screenshots.vlmStatus, "pending"), eq(screenshots.vlmStatus, "failed")),
          lt(screenshots.vlmAttempts, retryConfig.maxAttempts),
          isNotNull(screenshots.filePath),
          ne(screenshots.storageState, "deleted")
        )
      )
      .orderBy(asc(screenshots.createdAt))
      .limit(1)
      .get();
    if (orphan) {
      const minAgeMs = batchConfig.batchTimeoutMs + 5000;
      const eligibleAt = orphan.createdAt + minAgeMs;
      consider(eligibleAt <= now ? now : eligibleAt);
    }

    if (activitySummaryConfig.enabled && this.captureActive && this.captureActiveSince != null) {
      consider(this.lastActivitySeedAt + 60_000);
    }

    if (next == null) {
      return null;
    }

    return Math.max(next, now);
  }

  private async enqueueOrphanScreenshots(): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const minAgeMs = batchConfig.batchTimeoutMs + 5000;
    const cutoffCreatedAt = now - minAgeMs;

    const existingBatchRows = db
      .select({ id: batches.id, screenshotIds: batches.screenshotIds })
      .from(batches)
      .where(
        and(
          or(
            eq(batches.status, "pending"),
            eq(batches.status, "failed"),
            eq(batches.status, "running")
          ),
          lt(batches.attempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(desc(batches.updatedAt))
      .limit(reconcileConfig.batchSize)
      .all();

    for (const row of existingBatchRows) {
      try {
        const ids = JSON.parse(row.screenshotIds) as number[];
        if (ids.length === 0) continue;
        db.update(screenshots)
          .set({ enqueuedBatchId: row.id, updatedAt: now })
          .where(and(inArray(screenshots.id, ids), isNull(screenshots.enqueuedBatchId)))
          .run();
      } catch {
        continue;
      }
    }

    const candidates = db
      .select({
        id: screenshots.id,
        ts: screenshots.ts,
        sourceKey: screenshots.sourceKey,
        phash: screenshots.phash,
        filePath: screenshots.filePath,
        width: screenshots.width,
        height: screenshots.height,
        bytes: screenshots.bytes,
        mime: screenshots.mime,
        appHint: screenshots.appHint,
        windowTitle: screenshots.windowTitle,
      })
      .from(screenshots)
      .where(
        and(
          isNull(screenshots.enqueuedBatchId),
          or(eq(screenshots.vlmStatus, "pending"), eq(screenshots.vlmStatus, "failed")),
          lt(screenshots.vlmAttempts, retryConfig.maxAttempts),
          lte(screenshots.createdAt, cutoffCreatedAt),
          isNotNull(screenshots.filePath),
          ne(screenshots.storageState, "deleted")
        )
      )
      .orderBy(asc(screenshots.sourceKey), asc(screenshots.ts))
      .limit(reconcileConfig.batchSize)
      .all();

    if (candidates.length === 0) {
      return;
    }

    const bySource = new Map<SourceKey, typeof candidates>();
    for (const row of candidates) {
      const key = row.sourceKey as SourceKey;
      const arr = bySource.get(key);
      if (arr) {
        arr.push(row);
      } else {
        bySource.set(key, [row]);
      }
    }

    let createdBatches = 0;
    for (const [sourceKey, rows] of bySource) {
      for (let i = 0; i < rows.length; i += batchConfig.batchSize) {
        const chunk = rows.slice(i, i + batchConfig.batchSize);
        const accepted: AcceptedScreenshot[] = chunk.map((s) => ({
          id: s.id,
          ts: s.ts,
          sourceKey,
          phash: s.phash ?? "",
          filePath: s.filePath!,
          meta: {
            appHint: s.appHint ?? undefined,
            windowTitle: s.windowTitle ?? undefined,
            width: s.width ?? undefined,
            height: s.height ?? undefined,
            bytes: s.bytes ?? undefined,
            mime: s.mime ?? undefined,
          },
        }));

        try {
          const { batch } = await batchBuilder.createAndPersistBatch(sourceKey, accepted);
          createdBatches++;
          logger.info(
            { batchId: batch.batchId, sourceKey, screenshotCount: accepted.length },
            "Enqueued orphan screenshots into batch"
          );
        } catch (error) {
          logger.warn(
            { sourceKey, error: error instanceof Error ? error.message : String(error) },
            "Failed to enqueue orphan screenshots into batch"
          );
        }
      }
    }

    if (createdBatches > 0) {
      this.wakeRequested = true;
    }
  }

  /**
   * Stop the reconcile loop
   */
  stop(): void {
    this.isRunning = false;
    this.wakeScheduled = false;
    this.wakeRequested = false;
    this.clearTimer();
    logger.info("Reconcile loop stopped");
  }

  /**
   * Wake the reconcile loop to trigger an immediate run.
   * Uses debouncing to avoid queuing many setImmediate calls.
   */
  wake(): void {
    if (!this.isRunning) return;

    this.clearTimer();

    // If we're already processing, just remember to run again after this cycle.
    if (this.isProcessing) {
      this.wakeRequested = true;
      return;
    }

    if (this.wakeScheduled) return; // Already scheduled, skip
    this.wakeScheduled = true;
    setImmediate(() => {
      void this.run();
    });
  }

  /**
   * Main execution cycle
   */
  private async run(): Promise<void> {
    // Check if loop was stopped (e.g., after stop() but before queued setImmediate runs)
    if (!this.isRunning) {
      this.wakeScheduled = false;
      this.wakeRequested = false;
      return;
    }
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.wakeScheduled = false; // Clear wake flag at start of run

    try {
      const db = getDb();

      // 1. Recover stale 'running' states
      await this.recoverStaleStates();

      if (activitySummaryConfig.enabled) {
        const now = Date.now();
        const intervalMs = activitySummaryConfig.generationIntervalMs;
        const safetyLagMs = 5 * 60 * 1000; // allow pipeline to finish
        if (
          this.captureActive &&
          this.captureActiveSince &&
          now - this.lastActivitySeedAt > 60 * 1000
        ) {
          // Seed only complete windows that ended at least safetyLagMs ago
          const lastCompleteWindowEnd = this.alignToWindowStart(now - safetyLagMs, intervalMs);

          // Find latest existing window end
          const latest = db
            .select({ windowEnd: activitySummaries.windowEnd })
            .from(activitySummaries)
            .orderBy(desc(activitySummaries.windowEnd))
            .limit(1)
            .get();
          const latestWindowEnd = latest?.windowEnd ?? 0;

          // Start from captureActiveSince aligned to next boundary to avoid partial tail
          const seedFromAligned =
            this.alignToWindowStart(this.captureActiveSince, intervalMs) + intervalMs;
          const seedFrom = Math.max(latestWindowEnd, seedFromAligned);

          let insertedAny = false;
          for (
            let windowStart = seedFrom;
            windowStart + intervalMs <= lastCompleteWindowEnd;
            windowStart += intervalMs
          ) {
            const windowEnd = windowStart + intervalMs;
            const idempotencyKey = `win_${windowStart}_${windowEnd}`;
            const nextRunAt = windowEnd + safetyLagMs;
            const res = db
              .insert(activitySummaries)
              .values({
                windowStart,
                windowEnd,
                idempotencyKey,
                title: null,
                summary: "",
                highlights: null,
                stats: null,
                status: "pending",
                attempts: 0,
                nextRunAt,
                errorCode: null,
                errorMessage: null,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing({ target: activitySummaries.idempotencyKey })
              .run();
            if (res.changes > 0) {
              insertedAny = true;
            }
          }
          if (insertedAny) {
            this.wakeRequested = true;
          }

          this.lastActivitySeedAt = now;
        }
      }

      const records = await this.scanPendingRecords();
      for (const record of records) {
        await this.processRecord(record);
      }
      await this.enqueueOrphanScreenshots();
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Error in reconcile loop cycle"
      );
    } finally {
      this.isProcessing = false;

      if (!this.isRunning) {
        this.wakeScheduled = false;
        this.wakeRequested = false;
        this.clearTimer();
      } else if (this.wakeRequested) {
        this.wakeRequested = false;
        this.wake();
      } else {
        const now = Date.now();
        try {
          const nextRunAt = this.computeNextRunAt(now);
          let delayMs = IDLE_SCAN_INTERVAL_MS;
          if (nextRunAt != null) {
            delayMs = Math.max(0, nextRunAt - now);
            if (delayMs > IDLE_SCAN_INTERVAL_MS) {
              delayMs = IDLE_SCAN_INTERVAL_MS;
            }
          }

          this.schedule(delayMs);
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "Failed to compute next run time; falling back to idle schedule"
          );
          this.schedule(IDLE_SCAN_INTERVAL_MS);
        }
      }
    }
  }

  /**
   * Resets records stuck in 'running' state for too long back to 'pending'
   */
  private async recoverStaleStates(): Promise<void> {
    const db = getDb();
    const staleThreshold = Date.now() - reconcileConfig.staleRunningThresholdMs;

    const staleScreenshots = db
      .update(screenshots)
      .set({
        vlmStatus: "pending",
        vlmNextRunAt: null,
        updatedAt: Date.now(),
      })
      .where(and(eq(screenshots.vlmStatus, "running"), lt(screenshots.updatedAt, staleThreshold)))
      .run();

    if (staleScreenshots.changes > 0) {
      logger.info({ count: staleScreenshots.changes }, "Recovered stale VLM states in screenshots");
    }

    const staleBatches = db
      .update(batches)
      .set({
        status: "pending",
        nextRunAt: null,
        updatedAt: Date.now(),
      })
      .where(and(eq(batches.status, "running"), lt(batches.updatedAt, staleThreshold)))
      .run();

    if (staleBatches.changes > 0) {
      logger.info({ count: staleBatches.changes }, "Recovered stale states in batches");
    }

    // Recover context_nodes mergeStatus
    const staleNodes = db
      .update(contextNodes)
      .set({
        mergeStatus: "pending",
        updatedAt: Date.now(),
      })
      .where(
        and(eq(contextNodes.mergeStatus, "running"), lt(contextNodes.updatedAt, staleThreshold))
      )
      .run();

    if (staleNodes.changes > 0) {
      logger.info({ count: staleNodes.changes }, "Recovered stale merge states in context_nodes");
    }

    // Recover context_nodes embeddingStatus
    const staleEmbeddingNodes = db
      .update(contextNodes)
      .set({
        embeddingStatus: "pending",
        updatedAt: Date.now(),
      })
      .where(
        and(eq(contextNodes.embeddingStatus, "running"), lt(contextNodes.updatedAt, staleThreshold))
      )
      .run();

    if (staleEmbeddingNodes.changes > 0) {
      logger.info(
        { count: staleEmbeddingNodes.changes },
        "Recovered stale embedding states in context_nodes"
      );
    }

    // Recover vector_documents
    const now = Date.now();

    const staleVectorEmbeddings = db
      .update(vectorDocuments)
      .set({
        embeddingStatus: "pending",
        embeddingNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "running"),
          lt(vectorDocuments.updatedAt, staleThreshold)
        )
      )
      .run();

    const staleVectorIndexes = db
      .update(vectorDocuments)
      .set({
        indexStatus: "pending",
        indexNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(vectorDocuments.indexStatus, "running"),
          lt(vectorDocuments.updatedAt, staleThreshold)
        )
      )
      .run();

    const staleDocCount = staleVectorEmbeddings.changes + staleVectorIndexes.changes;
    if (staleDocCount > 0) {
      logger.info({ count: staleDocCount }, "Recovered stale states in vector_documents");
    }
  }

  private async scanPendingRecords(): Promise<PendingRecord[]> {
    const db = getDb();
    const now = Date.now();
    const limit = reconcileConfig.batchSize;

    // Note: We no longer scan screenshots directly.
    // All screenshots are processed through batches.
    // This avoids race conditions between screenshot-level and batch-level VLM processing.

    const batchRows = db
      .select({
        id: batches.id,
        status: batches.status,
        attempts: batches.attempts,
        nextRunAt: batches.nextRunAt,
      })
      .from(batches)
      .where(
        and(
          or(eq(batches.status, "pending"), eq(batches.status, "failed")),
          or(isNull(batches.nextRunAt), lte(batches.nextRunAt, now)),
          lt(batches.attempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    const mergeRows = db
      .select({
        id: contextNodes.id,
        status: contextNodes.mergeStatus,
        attempts: contextNodes.mergeAttempts,
        nextRunAt: contextNodes.mergeNextRunAt,
      })
      .from(contextNodes)
      .where(
        and(
          or(eq(contextNodes.mergeStatus, "pending"), eq(contextNodes.mergeStatus, "failed")),
          or(isNull(contextNodes.mergeNextRunAt), lte(contextNodes.mergeNextRunAt, now)),
          lt(contextNodes.mergeAttempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    // Note: We separated embedding/index scanning below, so removed the generic embeddingRows query block.

    const batchesPending: PendingRecord[] = batchRows.map((r) => ({
      id: r.id,
      table: "batches",
      status: r.status as "pending" | "failed",
      attempts: r.attempts,
      nextRunAt: r.nextRunAt ?? undefined,
    }));

    const mergesPending: PendingRecord[] = mergeRows.map((r) => ({
      id: r.id,
      table: "context_nodes",
      status: r.status as "pending" | "failed",
      attempts: r.attempts,
      nextRunAt: r.nextRunAt ?? undefined,
    }));

    const embeddingsPending: PendingRecord[] = [];

    // 1. Subtask: Embedding
    // embeddingStatus in ('pending','failed')
    const embeddingTasks = db
      .select({
        id: vectorDocuments.id,
        embeddingStatus: vectorDocuments.embeddingStatus,
        embeddingAttempts: vectorDocuments.embeddingAttempts,
        embeddingNextRunAt: vectorDocuments.embeddingNextRunAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          or(
            isNull(vectorDocuments.embeddingNextRunAt),
            lte(vectorDocuments.embeddingNextRunAt, now)
          ),
          lt(vectorDocuments.embeddingAttempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    for (const r of embeddingTasks) {
      embeddingsPending.push({
        id: r.id,
        table: "vector_documents",
        status: r.embeddingStatus as "pending" | "failed",
        attempts: r.embeddingAttempts,
        nextRunAt: r.embeddingNextRunAt ?? undefined,
        subtask: "embedding",
      });
    }

    // 2. Subtask: Indexing
    // indexStatus in ('pending','failed') AND embeddingStatus='succeeded'
    const indexTasks = db
      .select({
        id: vectorDocuments.id,
        indexStatus: vectorDocuments.indexStatus,
        indexAttempts: vectorDocuments.indexAttempts,
        indexNextRunAt: vectorDocuments.indexNextRunAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"), // prerequisite
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          or(isNull(vectorDocuments.indexNextRunAt), lte(vectorDocuments.indexNextRunAt, now)),
          lt(vectorDocuments.indexAttempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    for (const r of indexTasks) {
      embeddingsPending.push({
        id: r.id,
        table: "vector_documents",
        status: r.indexStatus as "pending" | "failed",
        attempts: r.indexAttempts,
        nextRunAt: r.indexNextRunAt ?? undefined,
        subtask: "index",
      });
    }

    // 3. Activity Summaries
    const summaryRows = db
      .select({
        id: activitySummaries.id,
        status: activitySummaries.status,
        attempts: activitySummaries.attempts,
        nextRunAt: activitySummaries.nextRunAt,
      })
      .from(activitySummaries)
      .where(
        and(
          or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed")),
          or(isNull(activitySummaries.nextRunAt), lte(activitySummaries.nextRunAt, now)),
          lt(activitySummaries.attempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    const summariesPending: PendingRecord[] = summaryRows.map((r) => ({
      id: r.id,
      table: "activity_summaries",
      status: r.status as "pending" | "failed",
      attempts: r.attempts,
      nextRunAt: r.nextRunAt ?? undefined,
    }));

    // 4. Activity Event Details
    const eventDetailsRows = db
      .select({
        id: activityEvents.id,
        status: activityEvents.detailsStatus,
        attempts: activityEvents.detailsAttempts,
        nextRunAt: activityEvents.detailsNextRunAt,
      })
      .from(activityEvents)
      .where(
        and(
          or(
            eq(activityEvents.detailsStatus, "pending"),
            eq(activityEvents.detailsStatus, "failed")
          ),
          or(isNull(activityEvents.detailsNextRunAt), lte(activityEvents.detailsNextRunAt, now)),
          lt(activityEvents.detailsAttempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    const eventDetailsPending: PendingRecord[] = eventDetailsRows.map((r) => ({
      id: r.id,
      table: "activity_events",
      status: r.status as "pending" | "failed",
      attempts: r.attempts,
      nextRunAt: r.nextRunAt ?? undefined,
    }));

    return [
      ...batchesPending,
      ...mergesPending,
      ...embeddingsPending,
      ...summariesPending,
      ...eventDetailsPending,
    ];
  }

  private async processRecord(record: PendingRecord): Promise<void> {
    switch (record.table) {
      case "batches":
        await this.processBatchRecord(record);
        return;
      case "context_nodes":
        await this.processContextNodeMergeRecord(record);
        return;
      case "vector_documents":
        if (record.subtask === "index") {
          await this.processVectorDocumentIndexRecord(record);
        } else {
          // Default to embedding if undefined or explicitly "embedding"
          await this.processVectorDocumentEmbeddingRecord(record);
        }
        return;
      case "activity_summaries":
        await this.processActivitySummaryRecord(record);
        return;
      case "activity_events":
        await this.processActivityEventRecord(record);
        return;
    }
  }

  private async processBatchRecord(record: PendingRecord): Promise<void> {
    const db = getDb();

    const batchRecord = db.select().from(batches).where(eq(batches.id, record.id)).get();

    if (!batchRecord) {
      return;
    }

    if (batchRecord.status !== "pending" && batchRecord.status !== "failed") {
      return;
    }

    if (batchRecord.attempts >= retryConfig.maxAttempts) {
      return;
    }

    let screenshotIds: number[] = [];
    try {
      screenshotIds = JSON.parse(batchRecord.screenshotIds) as number[];
    } catch {
      screenshotIds = [];
    }

    try {
      const now = Date.now();

      db.update(batches)
        .set({
          status: "running",
          errorMessage: null,
          errorCode: null,
          updatedAt: now,
        })
        .where(eq(batches.id, batchRecord.id))
        .run();

      if (screenshotIds.length > 0) {
        db.update(screenshots)
          .set({ vlmStatus: "running", enqueuedBatchId: batchRecord.id, updatedAt: now })
          .where(
            and(
              inArray(screenshots.id, screenshotIds),
              or(
                isNull(screenshots.enqueuedBatchId),
                eq(screenshots.enqueuedBatchId, batchRecord.id)
              )
            )
          )
          .run();
      }

      const shotRows = screenshotIds.length
        ? db.select().from(screenshots).where(inArray(screenshots.id, screenshotIds)).all()
        : [];

      const missing = shotRows.find((s) => !s.filePath);
      if (missing) {
        throw new Error(`Missing filePath for screenshot ${missing.id}`);
      }

      const sourceKey = batchRecord.sourceKey as SourceKey;
      const accepted: AcceptedScreenshot[] = shotRows.map((s) => ({
        id: s.id,
        ts: s.ts,
        sourceKey,
        phash: s.phash ?? "",
        filePath: s.filePath!,
        meta: {
          appHint: s.appHint ?? undefined,
          windowTitle: s.windowTitle ?? undefined,
          width: s.width ?? undefined,
          height: s.height ?? undefined,
          bytes: s.bytes ?? undefined,
          mime: s.mime ?? undefined,
        },
      }));

      let historyPack: HistoryPack | undefined;
      if (batchRecord.historyPack) {
        try {
          historyPack = JSON.parse(batchRecord.historyPack) as unknown as HistoryPack;
        } catch {
          historyPack = undefined;
        }
      }

      const batch: Batch = {
        batchId: batchRecord.batchId,
        sourceKey,
        screenshots: accepted,
        status: batchRecord.status,
        idempotencyKey: batchRecord.idempotencyKey,
        tsStart: batchRecord.tsStart,
        tsEnd: batchRecord.tsEnd,
        historyPack: historyPack ?? batchBuilder.buildHistoryPack(sourceKey),
      };

      const shards: Shard[] = batchBuilder.splitIntoShards(batch);
      const index = await runVlmOnBatch(batch, shards);

      await this.persistVlmEvidenceAndFinalize(index, batch);

      db.update(batches)
        .set({
          status: "succeeded",
          indexJson: JSON.stringify(index),
          errorMessage: null,
          errorCode: null,
          nextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(eq(batches.id, batchRecord.id))
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = batchRecord.attempts + 1;
      const isPermanent = attempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);
      const updatedAt = Date.now();

      db.update(batches)
        .set({
          status: isPermanent ? "failed_permanent" : "failed",
          attempts,
          nextRunAt: nextRun,
          errorMessage: message,
          updatedAt,
        })
        .where(eq(batches.id, batchRecord.id))
        .run();

      if (screenshotIds.length > 0) {
        const shotRows = db
          .select()
          .from(screenshots)
          .where(inArray(screenshots.id, screenshotIds))
          .all();
        for (const s of shotRows) {
          const nextAttempts = s.vlmAttempts + 1;
          const shotPermanent = nextAttempts >= retryConfig.maxAttempts;
          const shotNextRun = shotPermanent ? null : this.calculateNextRun(nextAttempts);
          db.update(screenshots)
            .set({
              vlmStatus: shotPermanent ? "failed_permanent" : "failed",
              vlmAttempts: nextAttempts,
              vlmNextRunAt: shotNextRun,
              vlmErrorMessage: message,
              updatedAt,
            })
            .where(eq(screenshots.id, s.id))
            .run();
        }
      }
    }
  }

  private async persistVlmEvidenceAndFinalize(index: VLMIndexResult, batch: Batch): Promise<void> {
    const db = getDb();
    const screenshotIds = batch.screenshots.map((s) => s.id);

    const currentAppHintById = new Map<number, string | null>();
    if (screenshotIds.length > 0) {
      const rows = db
        .select({ id: screenshots.id, appHint: screenshots.appHint })
        .from(screenshots)
        .where(inArray(screenshots.id, screenshotIds))
        .all();
      for (const r of rows) {
        currentAppHintById.set(r.id, r.appHint ?? null);
      }
    }

    const retentionTtlMs = 1 * 60 * 60 * 1000;
    const retentionExpiresAt = Date.now() + retentionTtlMs;
    const updatedAt = Date.now();

    const shots = index.screenshots ?? [];
    const shotsById = new Map(shots.map((s) => [s.screenshot_id, s] as const));
    const detectedEntities: DetectedEntity[] = (index.entities ?? []).map((name: string) => ({
      name,
      entityType: "other",
      confidence: 0.7,
      source: "vlm",
    }));
    const detectedEntitiesJson = JSON.stringify(detectedEntities);

    const canonicalApps = getCanonicalAppCandidates();
    const canonicalByLower = new Map(
      canonicalApps.map((name) => [name.toLowerCase(), name] as const)
    );

    for (const screenshotId of screenshotIds) {
      const shot = shotsById.get(screenshotId);
      const existingAppHint = currentAppHintById.get(screenshotId) ?? null;
      const setValues: Partial<typeof screenshots.$inferInsert> = {
        vlmStatus: "succeeded",
        vlmNextRunAt: null,
        vlmErrorMessage: null,
        vlmErrorCode: null,
        retentionExpiresAt,
        detectedEntities: detectedEntitiesJson,
        ocrText: null,
        uiTextSnippets: null,
        updatedAt,
      };

      if (existingAppHint == null) {
        const guess = shot?.app_guess;
        const confidence = typeof guess?.confidence === "number" ? guess.confidence : null;
        const rawName = typeof guess?.name === "string" ? guess.name.trim() : "";
        const lower = rawName.toLowerCase();
        const canonical = canonicalByLower.get(lower) ?? null;
        if (
          confidence != null &&
          confidence >= 0.7 &&
          canonical != null &&
          lower !== "unknown" &&
          lower !== "other"
        ) {
          setValues.appHint = canonical;
        }
      }

      if (shot?.ocr_text != null) {
        setValues.ocrText = String(shot.ocr_text).slice(0, evidenceConfig.maxOcrTextLength);
      }

      if (shot?.ui_text_snippets != null) {
        const uiSnippets = (shot.ui_text_snippets as string[])
          .slice(0, evidenceConfig.maxUiTextSnippets)
          .map((s) => String(s).slice(0, 200));
        setValues.uiTextSnippets = JSON.stringify(uiSnippets);
      }

      db.update(screenshots).set(setValues).where(eq(screenshots.id, screenshotId)).run();
    }

    try {
      const expandResult = await expandVLMIndexToNodes(index, batch);

      // Milestone 1 integration: Sync vector documents for new nodes
      // We do this inside the batch flow so it's consistent.
      if (expandResult.success && expandResult.nodeIds.length > 0) {
        let upsertCount = 0;
        for (const nodeIdStr of expandResult.nodeIds) {
          try {
            const nodeId = parseInt(nodeIdStr, 10);
            if (!isNaN(nodeId)) {
              await vectorDocumentService.upsertForContextNode(nodeId);
              upsertCount++;
            }
          } catch (err) {
            logger.warn(
              { nodeIdStr, error: String(err) },
              "Failed to upsert vector doc for new node"
            );
          }
        }
        logger.info({ upsertCount }, "Upserted vector documents for new nodes");
      }
    } catch (error) {
      logger.warn(
        { batchId: batch.batchId, error: error instanceof Error ? error.message : String(error) },
        "Text LLM expansion failed; continuing without blocking VLM pipeline"
      );
    }
  }

  private async processContextNodeMergeRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const node = db.select().from(contextNodes).where(eq(contextNodes.id, record.id)).get() as
      | ContextNodeRecord
      | undefined;

    if (!node) {
      return;
    }

    try {
      db.update(contextNodes)
        .set({ mergeStatus: "running", updatedAt: Date.now() })
        .where(eq(contextNodes.id, node.id))
        .run();

      await this.handleSingleMerge(node);
    } catch (error) {
      const attempts = node.mergeAttempts + 1;
      const isPermanent = attempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);

      db.update(contextNodes)
        .set({
          mergeStatus: isPermanent ? "failed_permanent" : "failed",
          mergeAttempts: attempts,
          mergeNextRunAt: nextRun,
          mergeErrorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(contextNodes.id, node.id))
        .run();
    }
  }

  private async processVectorDocumentEmbeddingRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();

    if (!doc) return;

    // Check if we already succeeded (race condition or redundant queue)
    if (doc.embeddingStatus === "succeeded") return;

    try {
      // 1. Mark running
      db.update(vectorDocuments)
        .set({ embeddingStatus: "running", updatedAt: Date.now() })
        .where(eq(vectorDocuments.id, doc.id))
        .run();

      // 2. Get text content
      if (!doc.refId) {
        throw new Error("Vector document missing refId");
      }

      // We assume refId points to contextNodes based on our current usage
      const text = await vectorDocumentService.buildTextForNode(doc.refId);

      // 3. Generate embedding
      const vector = await embeddingService.embed(text);

      if (vector.length !== vectorStoreConfig.numDimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${vectorStoreConfig.numDimensions}, got ${vector.length}`
        );
      }

      // 4. Save embedding blob
      const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

      db.update(vectorDocuments)
        .set({
          embedding: buffer,
          embeddingStatus: "succeeded",
          embeddingNextRunAt: null,
          errorMessage: null,
          errorCode: null,
          // Trigger indexing next
          indexStatus: "pending",
          indexAttempts: 0,
          indexNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();

      logger.debug({ docId: doc.id }, "Generated embedding for vector document");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = doc.embeddingAttempts + 1;
      const isPermanent = attempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);

      db.update(vectorDocuments)
        .set({
          embeddingStatus: isPermanent ? "failed_permanent" : "failed",
          embeddingAttempts: attempts,
          embeddingNextRunAt: nextRun,
          errorMessage: message,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();
    }
  }

  private async processVectorDocumentIndexRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();

    if (!doc) return;

    // Must have embedding succeeded first
    if (doc.embeddingStatus !== "succeeded" || !doc.embedding) {
      // Should not happen if scan logic is correct, but safety check
      return;
    }

    try {
      // 1. Mark running
      db.update(vectorDocuments)
        .set({ indexStatus: "running", updatedAt: Date.now() })
        .where(eq(vectorDocuments.id, doc.id))
        .run();

      // 2. Convert BLOB -> Float32Array
      const buffer = doc.embedding as Buffer;
      const vector = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

      if (vector.length !== vectorStoreConfig.numDimensions) {
        throw new Error(
          `Indexing dimension mismatch: expected ${vectorStoreConfig.numDimensions}, got ${vector.length}`
        );
      }

      // 3. Upsert into HNSW index
      // Use vector_documents.id as numerical ID for HNSW
      await vectorIndexService.upsert(doc.id, vector);
      await vectorIndexService.flush();

      // 4. Mark succeeded
      db.update(vectorDocuments)
        .set({
          indexStatus: "succeeded",
          indexNextRunAt: null,
          errorMessage: null,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();

      logger.debug({ docId: doc.id }, "Indexed vector document");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = doc.indexAttempts + 1;
      const isPermanent = attempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);

      db.update(vectorDocuments)
        .set({
          indexStatus: isPermanent ? "failed_permanent" : "failed",
          indexAttempts: attempts,
          indexNextRunAt: nextRun,
          errorMessage: message,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();
    }
  }

  /**
   * Logic for merging a single node into the graph
   */
  private async handleSingleMerge(nodeRecord: ContextNodeRecord): Promise<void> {
    // 1. Convert DB record to ExpandedContextNode
    const node: ExpandedContextNode = {
      id: nodeRecord.id,
      kind: nodeRecord.kind,
      threadId: nodeRecord.threadId ?? undefined,
      title: nodeRecord.title,
      summary: nodeRecord.summary,
      keywords: nodeRecord.keywords ? JSON.parse(nodeRecord.keywords) : [],
      entities: nodeRecord.entities ? JSON.parse(nodeRecord.entities) : [],
      importance: nodeRecord.importance,
      confidence: nodeRecord.confidence,
      eventTime: nodeRecord.eventTime ?? undefined,
      screenshotIds: [], // Will be filled below
      mergedFromIds: nodeRecord.mergedFromIds ? JSON.parse(nodeRecord.mergedFromIds) : [],
    };

    // 2. Fetch screenshot links
    node.screenshotIds = contextGraphService.getLinkedScreenshots(nodeRecord.id.toString());

    // If the node has no threadId, we can't safely find a merge target.
    // Treat it as self-contained and mark merge as succeeded.
    if (!node.threadId) {
      await contextGraphService.updateNode(nodeRecord.id.toString(), {
        mergeStatus: "succeeded",
      });
      return;
    }

    // 3. Find potential merge target (heuristic: same thread, same kind, latest succeeded node)
    const targetRecord = getDb()
      .select()
      .from(contextNodes)
      .where(
        and(
          eq(contextNodes.threadId, node.threadId),
          eq(contextNodes.kind, node.kind),
          eq(contextNodes.mergeStatus, "succeeded"),
          ne(contextNodes.id, nodeRecord.id)
        )
      )
      .orderBy(desc(contextNodes.eventTime))
      .limit(1)
      .get() as ContextNodeRecord | undefined;

    if (!targetRecord) {
      // No target found, just mark as succeeded (self-contained node)
      await contextGraphService.updateNode(nodeRecord.id.toString(), {
        mergeStatus: "succeeded",
      });
      return;
    }

    // 4. Perform merge
    const target: ExpandedContextNode = {
      id: targetRecord.id,
      kind: targetRecord.kind,
      threadId: targetRecord.threadId ?? undefined,
      title: targetRecord.title,
      summary: targetRecord.summary,
      keywords: targetRecord.keywords ? JSON.parse(targetRecord.keywords) : [],
      entities: targetRecord.entities ? JSON.parse(targetRecord.entities) : [],
      importance: targetRecord.importance,
      confidence: targetRecord.confidence,
      eventTime: targetRecord.eventTime ?? undefined,
      screenshotIds: contextGraphService.getLinkedScreenshots(targetRecord.id.toString()),
      mergedFromIds: targetRecord.mergedFromIds ? JSON.parse(targetRecord.mergedFromIds) : [],
    };

    const mergeResult = await textLLMProcessor.executeMerge(node, target);

    // 5. Update target node and mark current node as succeeded (or similar mechanism)
    // In our design, we update the target node with merged content and mark the new node as succeeded
    // AND we should track mergedFromIds to maintain the lineage.

    // We update targetNode with mergeResult.mergedNode
    await contextGraphService.updateNode(targetRecord.id.toString(), {
      title: mergeResult.mergedNode.title,
      summary: mergeResult.mergedNode.summary,
      keywords: mergeResult.mergedNode.keywords,
      entities: mergeResult.mergedNode.entities,
      importance: mergeResult.mergedNode.importance,
      confidence: mergeResult.mergedNode.confidence,
      mergedFromIds: mergeResult.mergedFromIds,
    });

    // Milestone 4 integration: Sync entity mentions for the updated target node (only if it's an event)
    if (targetRecord.kind === "event") {
      try {
        await entityService.syncEventEntityMentions(
          targetRecord.id,
          mergeResult.mergedNode.entities,
          "llm"
        );
      } catch (err) {
        logger.warn(
          { targetId: targetRecord.id, error: String(err) },
          "Failed to sync entity mentions for merged target node"
        );
      }
    }

    // Link new node's screenshots to target node
    for (const screenshotId of node.screenshotIds) {
      await contextGraphService.linkScreenshot(targetRecord.id.toString(), screenshotId.toString());
    }

    // Finally mark the current node as succeeded (it has been merged into target)
    await contextGraphService.updateNode(nodeRecord.id.toString(), {
      mergeStatus: "succeeded",
    });

    // Milestone 1 integration: Sync vector document for the updated target node
    try {
      await vectorDocumentService.upsertForContextNode(targetRecord.id);
    } catch (err) {
      logger.warn(
        { targetId: targetRecord.id, error: String(err) },
        "Failed to upsert vector doc for merged target node"
      );
    }

    logger.info({ sourceId: node.id, targetId: target.id }, "Merged node into target");
  }

  private async processActivitySummaryRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const summary = db
      .select()
      .from(activitySummaries)
      .where(eq(activitySummaries.id, record.id))
      .get();

    if (!summary || (summary.status !== "pending" && summary.status !== "failed")) {
      return;
    }

    try {
      await db
        .update(activitySummaries)
        .set({ status: "running", updatedAt: Date.now() })
        .where(eq(activitySummaries.id, record.id))
        .run();

      const success = await activityMonitorService.generateWindowSummary(
        summary.windowStart,
        summary.windowEnd
      );

      if (!success) {
        throw new Error("Generation failed");
      }
    } catch (error) {
      const nextAttempts = record.attempts + 1;
      const nextRunAt = this.calculateNextRun(nextAttempts);
      await db
        .update(activitySummaries)
        .set({
          status: "failed",
          attempts: nextAttempts,
          nextRunAt,
          errorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(activitySummaries.id, record.id))
        .run();
    }
  }

  private async processActivityEventRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const event = db.select().from(activityEvents).where(eq(activityEvents.id, record.id)).get();

    if (!event || (event.detailsStatus !== "pending" && event.detailsStatus !== "failed")) {
      return;
    }

    try {
      await db
        .update(activityEvents)
        .set({ detailsStatus: "running", updatedAt: Date.now() })
        .where(eq(activityEvents.id, record.id))
        .run();

      const success = await activityMonitorService.generateEventDetails(event.id);

      if (!success) {
        throw new Error("Details generation failed");
      }
    } catch (error) {
      const nextAttempts = (event.detailsAttempts || 0) + 1;
      const nextRunAt = this.calculateNextRun(nextAttempts);
      await db
        .update(activityEvents)
        .set({
          detailsStatus: "failed",
          detailsAttempts: nextAttempts,
          detailsNextRunAt: nextRunAt,
          detailsErrorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(activityEvents.id, record.id))
        .run();
    }
  }

  /**
   * Calculates next run time with exponential backoff and jitter
   */
  private calculateNextRun(attempts: number): number {
    const { backoffScheduleMs, jitterMs } = retryConfig;
    const baseDelay = backoffScheduleMs[Math.min(attempts - 1, backoffScheduleMs.length - 1)];
    const jitter = Math.random() * jitterMs;
    return Date.now() + baseDelay + jitter;
  }
}

export const reconcileLoop = new ReconcileLoop();
