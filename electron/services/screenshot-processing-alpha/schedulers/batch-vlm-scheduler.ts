import { eq, and, lt, or, isNull, lte, asc, desc, inArray } from "drizzle-orm";
import { getDb } from "../../../database";
import { batches, screenshots } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import type { VLMContextNode } from "../schemas";
import { PendingBatchRecord } from "../types";
import type { ScreenshotRecord } from "../../../database/schema";
import { vlmProcessor } from "../vlm-processor";
import { contextNodeService } from "../context-node-service";
import { safeDeleteCaptureFile } from "../../screen-capture/capture-storage";
import { ocrScheduler } from "./ocr-scheduler";
import { threadScheduler } from "./thread-scheduler";
import { aiRuntimeService } from "../../ai-runtime-service";

const logger = getLogger("batch-vlm-scheduler");

export class BatchVlmScheduler extends BaseScheduler {
  protected name = "BatchVlmScheduler";
  private minDelayMs = 2000;
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Batch VLM scheduler started");
    this.emit("scheduler:started", { scheduler: this.name, timestamp: Date.now() });
    this.scheduleSoon();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.clearTimer();
    logger.info("Batch VLM scheduler stopped");
    this.emit("scheduler:stopped", { scheduler: this.name, timestamp: Date.now() });
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for batch VLM scheduler");
    this.emit("scheduler:waked", { scheduler: this.name, timestamp: Date.now(), reason });

    if (this.isProcessing) {
      this.wakeRequested = true;
      return;
    }

    this.scheduleSoon();
  }

  protected getDefaultIntervalMs(): number {
    return this.defaultIntervalMs;
  }

  protected getMinDelayMs(): number {
    return this.minDelayMs;
  }

  protected computeEarliestNextRun(): number | null {
    const db = getDb();
    const now = Date.now();

    const row = db
      .select({ nextRunAt: batches.vlmNextRunAt })
      .from(batches)
      .where(
        and(
          or(eq(batches.vlmStatus, "pending"), eq(batches.vlmStatus, "failed")),
          lt(batches.vlmAttempts, processingConfig.retry.maxAttempts),
          or(isNull(batches.vlmNextRunAt), lte(batches.vlmNextRunAt, now))
        )
      )
      .orderBy(asc(batches.vlmNextRunAt))
      .limit(1)
      .get();

    if (!row) {
      return null;
    }

    return row.nextRunAt ?? now;
  }

  protected async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    this.isProcessing = true;
    const cycleStartTs = Date.now();
    logger.debug("Starting batch VLM scheduler cycle");
    this.emit("scheduler:cycle:start", { scheduler: this.name, timestamp: cycleStartTs });

    let cycleError: string | undefined;
    try {
      await this.recoverStaleStates();

      const records = await this.scanPendingRecords();
      if (records.length === 0) {
        return;
      }

      const concurrency = Math.max(1, Math.min(aiRuntimeService.getLimit("vlm"), 2));
      const lanes = this.splitByLane(records);

      await this.processInLanes({
        lanes,
        concurrency,
        laneWeights: { realtime: 3, recovery: 1 },
        handler: async (record) => {
          await this.processOneBatch(record);
        },
        onError: (error, record) => {
          logger.error({ error, batchId: record.batchId }, "Unhandled error processing batch");
        },
      });
    } catch (error) {
      cycleError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Error in batch VLM scheduler cycle");
    } finally {
      this.emit("scheduler:cycle:end", {
        scheduler: this.name,
        timestamp: Date.now(),
        durationMs: Date.now() - cycleStartTs,
        error: cycleError,
      });
      this.isProcessing = false;
      if (this.isRunning) {
        if (this.wakeRequested) {
          this.wakeRequested = false;
          this.scheduleSoon();
        } else {
          this.scheduleNext();
        }
      }
    }
  }

  protected async recoverStaleStates(): Promise<void> {
    const db = getDb();
    const staleThreshold = Date.now() - processingConfig.scheduler.staleRunningThresholdMs;

    try {
      const result = await db
        .update(batches)
        .set({
          vlmStatus: "pending",
          vlmNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(batches.vlmStatus, "running"), lt(batches.updatedAt, staleThreshold)));

      if (result.changes > 0) {
        logger.info({ recovered: result.changes }, "Recovered stale VLM batches");
      }
    } catch (error) {
      logger.error({ error }, "Failed to recover stale VLM batches");
    }
  }

  private async scanPendingRecords(): Promise<PendingBatchRecord[]> {
    const db = getDb();
    const now = Date.now();
    const limit = 100;
    const sliceLimit = Math.max(1, Math.ceil(limit / 2));

    const baseWhere = and(
      or(eq(batches.vlmStatus, "pending"), eq(batches.vlmStatus, "failed")),
      lt(batches.vlmAttempts, processingConfig.retry.maxAttempts),
      or(isNull(batches.vlmNextRunAt), lte(batches.vlmNextRunAt, now))
    );

    const newest = db
      .select()
      .from(batches)
      .where(baseWhere)
      .orderBy(desc(batches.updatedAt))
      .limit(sliceLimit)
      .all();

    const oldest = db
      .select()
      .from(batches)
      .where(baseWhere)
      .orderBy(asc(batches.updatedAt))
      .limit(sliceLimit)
      .all();

    const merged = new Map<number, PendingBatchRecord>();
    for (const row of [...newest, ...oldest]) {
      const screenshotIds = parseScreenshotIds(row.screenshotIds, row.id);
      if (screenshotIds.length === 0) {
        continue;
      }
      merged.set(row.id, {
        id: row.id,
        batchId: row.batchId,
        sourceKey: row.sourceKey,
        screenshotIds,
        tsStart: row.tsStart,
        tsEnd: row.tsEnd,
        vlmAttempts: row.vlmAttempts,
        updatedAt: row.updatedAt,
      });
    }

    return Array.from(merged.values());
  }

  private splitByLane(
    records: PendingBatchRecord[]
  ): Record<"realtime" | "recovery", PendingBatchRecord[]> {
    const now = Date.now();
    const laneCutoff = now - processingConfig.scheduler.laneRecoveryAgeMs;

    return records.reduce(
      (acc, record) => {
        if (record.updatedAt < laneCutoff) {
          acc.recovery.push(record);
        } else {
          acc.realtime.push(record);
        }
        return acc;
      },
      { realtime: [] as PendingBatchRecord[], recovery: [] as PendingBatchRecord[] }
    );
  }

  private async processOneBatch(record: PendingBatchRecord): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const attempts = record.vlmAttempts + 1;

    const claimed = db
      .update(batches)
      .set({
        vlmStatus: "running",
        vlmAttempts: attempts,
        vlmNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(batches.id, record.id),
          or(eq(batches.vlmStatus, "pending"), eq(batches.vlmStatus, "failed")),
          lt(batches.vlmAttempts, processingConfig.retry.maxAttempts)
        )
      )
      .run();

    if (claimed.changes === 0) {
      return;
    }

    const screenshotRows = db
      .select()
      .from(screenshots)
      .where(inArray(screenshots.id, record.screenshotIds))
      .all();

    const rowById = new Map(screenshotRows.map((row) => [row.id, row] as const));
    const orderedScreenshots = record.screenshotIds
      .map((id) => rowById.get(id))
      .filter((row): row is ScreenshotRecord => Boolean(row));

    if (orderedScreenshots.length === 0) {
      await this.failBatch(record.id, attempts, "No screenshots found for batch");
      return;
    }

    try {
      const nodes = await vlmProcessor.processBatch({
        batchId: record.batchId,
        sourceKey: record.sourceKey,
        screenshots: orderedScreenshots.map((row) => ({
          id: row.id,
          ts: row.ts,
          sourceKey: row.sourceKey,
          filePath: row.filePath ?? null,
          appHint: row.appHint ?? null,
          windowTitle: row.windowTitle ?? null,
        })),
      });

      await this.persistResults(record, orderedScreenshots, nodes);
      await this.markBatchSucceeded(record.id, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failBatch(record.id, attempts, message);
    }
  }

  private async persistResults(
    record: PendingBatchRecord,
    screenshotsForBatch: ScreenshotRecord[],
    nodes: VLMContextNode[]
  ): Promise<void> {
    const db = getDb();
    const now = Date.now();

    const screenshotByIndex = screenshotsForBatch.map((row) => row);
    const ocrPendingIds: number[] = [];

    for (const node of nodes) {
      const screenshot = screenshotByIndex[node.screenshotIndex - 1];
      if (!screenshot) {
        logger.warn(
          { batchId: record.batchId, screenshotIndex: node.screenshotIndex },
          "VLM node missing screenshot"
        );
        continue;
      }

      const mergedAppHint = screenshot.appHint ?? node.appContext.appHint ?? null;
      const mergedWindowTitle = screenshot.windowTitle ?? node.appContext.windowTitle ?? null;

      const needsOcr =
        !!node.knowledge &&
        processingConfig.ocr.supportedLanguages.includes(node.knowledge.language) &&
        !!screenshot.filePath &&
        screenshot.storageState !== "deleted";

      const ocrStatus = needsOcr ? "pending" : null;
      if (needsOcr) {
        ocrPendingIds.push(screenshot.id);
      }

      db.update(screenshots)
        .set({
          appHint: mergedAppHint,
          windowTitle: mergedWindowTitle,
          ocrStatus,
          ocrAttempts: needsOcr ? 0 : screenshot.ocrAttempts,
          ocrNextRunAt: needsOcr ? null : screenshot.ocrNextRunAt,
          updatedAt: now,
        })
        .where(eq(screenshots.id, screenshot.id))
        .run();

      await contextNodeService.upsertNodeForScreenshot({
        batchId: record.id,
        screenshotId: screenshot.id,
        screenshotTs: screenshot.ts,
        title: node.title,
        summary: node.summary,
        appContext: node.appContext,
        knowledge: node.knowledge,
        stateSnapshot: node.stateSnapshot,
        uiTextSnippets: node.uiTextSnippets,
        keywords: node.keywords,
        importance: node.importance,
        confidence: node.confidence,
      });

      if (!needsOcr && screenshot.filePath && screenshot.storageState !== "deleted") {
        const deleted = await safeDeleteCaptureFile(screenshot.filePath);
        if (deleted) {
          db.update(screenshots)
            .set({ storageState: "deleted", updatedAt: now })
            .where(eq(screenshots.id, screenshot.id))
            .run();
        }
      }
    }

    if (ocrPendingIds.length > 0) {
      this.emit("screenshot:ocr:queued", { screenshotIds: ocrPendingIds, timestamp: now });
      ocrScheduler.wake("vlm:ocr_pending");
    }

    threadScheduler.wake("vlm:succeeded");
  }

  private async markBatchSucceeded(batchId: number, now: number): Promise<void> {
    const db = getDb();
    db.update(batches)
      .set({
        vlmStatus: "succeeded",
        vlmErrorMessage: null,
        vlmNextRunAt: null,
        threadLlmStatus: "pending",
        threadLlmNextRunAt: null,
        updatedAt: now,
      })
      .where(eq(batches.id, batchId))
      .run();

    this.emit("batch:vlm:succeeded", { batchId, timestamp: now });
  }

  private async failBatch(batchId: number, attempts: number, errorMessage: string): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const exceeded = attempts >= processingConfig.retry.maxAttempts;
    const nextRunAt = exceeded ? null : now + processingConfig.retry.delayMs;
    const status = exceeded ? "failed_permanent" : "failed";

    db.update(batches)
      .set({
        vlmStatus: status,
        vlmErrorMessage: errorMessage.slice(0, 500),
        vlmNextRunAt: nextRunAt,
        updatedAt: now,
      })
      .where(eq(batches.id, batchId))
      .run();

    this.emit("batch:vlm:failed", {
      batchId,
      timestamp: now,
      error: errorMessage,
      attempts,
      permanent: exceeded,
    });
  }
}

export const batchVlmScheduler = new BatchVlmScheduler();

function parseScreenshotIds(raw: string, batchId: number): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id) => typeof id === "number");
  } catch (error) {
    logger.warn({ batchId, error }, "Failed to parse batch screenshot_ids");
    return [];
  }
}

export const __test__ = {
  parseScreenshotIds,
};
