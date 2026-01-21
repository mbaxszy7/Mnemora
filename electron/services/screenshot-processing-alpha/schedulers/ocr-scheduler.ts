import { eq, and, lt, isNotNull, or, isNull, lte, asc, desc, ne, gte } from "drizzle-orm";
import { getDb } from "../../../database";
import { contextNodes, contextScreenshotLinks, screenshots } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import { safeDeleteCaptureFile } from "../../screen-capture/capture-storage";
import { ocrService } from "../ocr-service";
import type { KnowledgePayload } from "../types";

const logger = getLogger("ocr-scheduler");

export class OcrScheduler extends BaseScheduler {
  protected name = "OcrScheduler";
  private minDelayMs = 2000;
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("OCR scheduler started");
    this.emit("scheduler:started", { scheduler: this.name, timestamp: Date.now() });
    this.scheduleSoon();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.clearTimer();
    logger.info("OCR scheduler stopped");
    this.emit("scheduler:stopped", { scheduler: this.name, timestamp: Date.now() });
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for OCR scheduler");
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
      .select({ nextRunAt: screenshots.ocrNextRunAt })
      .from(screenshots)
      .where(
        and(
          or(eq(screenshots.ocrStatus, "pending"), eq(screenshots.ocrStatus, "failed")),
          lt(screenshots.ocrAttempts, processingConfig.retry.maxAttempts),
          or(isNull(screenshots.ocrNextRunAt), lte(screenshots.ocrNextRunAt, now)),
          isNotNull(screenshots.filePath),
          or(isNull(screenshots.storageState), ne(screenshots.storageState, "deleted"))
        )
      )
      .orderBy(asc(screenshots.ocrNextRunAt))
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
    logger.debug("Starting OCR scheduler cycle");
    this.emit("scheduler:cycle:start", { scheduler: this.name, timestamp: cycleStartTs });

    let cycleError: string | undefined;
    try {
      await this.recoverStaleStates();

      const records = this.scanPendingRecords();
      if (records.length === 0) {
        return;
      }

      const lanes = this.splitByLane(records);
      const concurrency = Math.max(1, Math.floor(processingConfig.ocr.concurrency));

      await this.processInLanes({
        lanes,
        concurrency,
        laneWeights: { realtime: 3, recovery: 1 },
        handler: async (record) => {
          await this.processOneScreenshot(record);
        },
        onError: (error, record) => {
          logger.error({ error, screenshotId: record.id }, "Unhandled OCR error");
        },
      });
    } catch (error) {
      cycleError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Error in OCR scheduler cycle");
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
    const now = Date.now();
    const staleThreshold = now - processingConfig.scheduler.staleRunningThresholdMs;

    try {
      const maxAttempts = processingConfig.retry.maxAttempts;

      const permanent = db
        .update(screenshots)
        .set({
          ocrStatus: "failed_permanent",
          ocrNextRunAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(screenshots.ocrStatus, "running"),
            lt(screenshots.updatedAt, staleThreshold),
            gte(screenshots.ocrAttempts, maxAttempts),
            isNotNull(screenshots.filePath),
            or(isNull(screenshots.storageState), ne(screenshots.storageState, "deleted"))
          )
        )
        .run();

      const recovered = db
        .update(screenshots)
        .set({
          ocrStatus: "pending",
          ocrNextRunAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(screenshots.ocrStatus, "running"),
            lt(screenshots.updatedAt, staleThreshold),
            lt(screenshots.ocrAttempts, maxAttempts),
            isNotNull(screenshots.filePath),
            or(isNull(screenshots.storageState), ne(screenshots.storageState, "deleted"))
          )
        )
        .run();

      const changed = recovered.changes + permanent.changes;
      if (changed > 0) {
        logger.info(
          { recovered: recovered.changes, permanent: permanent.changes },
          "Recovered stale OCR screenshots"
        );
      }
    } catch (error) {
      logger.error({ error }, "Failed to recover stale OCR screenshots");
    }
  }

  private scanPendingRecords(): PendingOcrRecord[] {
    const db = getDb();
    const now = Date.now();
    const limit = processingConfig.scheduler.scanCap;
    const sliceLimit = Math.max(1, Math.ceil(limit / 2));

    const baseWhere = and(
      or(eq(screenshots.ocrStatus, "pending"), eq(screenshots.ocrStatus, "failed")),
      lt(screenshots.ocrAttempts, processingConfig.retry.maxAttempts),
      or(isNull(screenshots.ocrNextRunAt), lte(screenshots.ocrNextRunAt, now)),
      isNotNull(screenshots.filePath),
      or(isNull(screenshots.storageState), ne(screenshots.storageState, "deleted"))
    );

    const newest = db
      .select({
        id: screenshots.id,
        ocrAttempts: screenshots.ocrAttempts,
        createdAt: screenshots.createdAt,
        updatedAt: screenshots.updatedAt,
      })
      .from(screenshots)
      .where(baseWhere)
      .orderBy(desc(screenshots.updatedAt))
      .limit(sliceLimit)
      .all();

    const oldest = db
      .select({
        id: screenshots.id,
        ocrAttempts: screenshots.ocrAttempts,
        createdAt: screenshots.createdAt,
        updatedAt: screenshots.updatedAt,
      })
      .from(screenshots)
      .where(baseWhere)
      .orderBy(asc(screenshots.updatedAt))
      .limit(sliceLimit)
      .all();

    const merged = new Map<number, PendingOcrRecord>();
    for (const row of [...newest, ...oldest]) {
      merged.set(row.id, {
        id: row.id,
        ocrAttempts: row.ocrAttempts,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }

    return Array.from(merged.values());
  }

  private splitByLane(
    records: PendingOcrRecord[]
  ): Record<"realtime" | "recovery", PendingOcrRecord[]> {
    const now = Date.now();
    const laneCutoff = now - processingConfig.scheduler.laneRecoveryAgeMs;

    const lanes = records.reduce(
      (acc, record) => {
        if (record.ocrAttempts > 0 || record.updatedAt < laneCutoff) {
          acc.recovery.push(record);
        } else {
          acc.realtime.push(record);
        }
        return acc;
      },
      { realtime: [] as PendingOcrRecord[], recovery: [] as PendingOcrRecord[] }
    );

    lanes.realtime.sort((a, b) => b.updatedAt - a.updatedAt);
    lanes.recovery.sort((a, b) => a.updatedAt - b.updatedAt);
    return lanes;
  }

  private async processOneScreenshot(record: PendingOcrRecord): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const attempts = record.ocrAttempts + 1;

    const claimed = db
      .update(screenshots)
      .set({
        ocrStatus: "running",
        ocrAttempts: attempts,
        ocrNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(screenshots.id, record.id),
          or(eq(screenshots.ocrStatus, "pending"), eq(screenshots.ocrStatus, "failed")),
          lt(screenshots.ocrAttempts, processingConfig.retry.maxAttempts),
          or(isNull(screenshots.ocrNextRunAt), lte(screenshots.ocrNextRunAt, now)),
          isNotNull(screenshots.filePath),
          or(isNull(screenshots.storageState), ne(screenshots.storageState, "deleted"))
        )
      )
      .run();

    if (claimed.changes === 0) {
      return;
    }

    const screenshot = db.select().from(screenshots).where(eq(screenshots.id, record.id)).get();
    if (!screenshot || !screenshot.filePath || screenshot.storageState === "deleted") {
      await this.failScreenshot(record.id, attempts, "Screenshot file not available");
      return;
    }

    const textRegion = this.loadTextRegion(screenshot.id);

    try {
      const result = await ocrService.recognize({
        filePath: screenshot.filePath,
        textRegion,
      });

      db.update(screenshots)
        .set({
          ocrText: result.text,
          ocrStatus: "succeeded",
          ocrNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(eq(screenshots.id, screenshot.id))
        .run();

      this.emit("screenshot:ocr:succeeded", {
        screenshotId: screenshot.id,
        timestamp: Date.now(),
        attempts,
      });

      const deleted = await safeDeleteCaptureFile(screenshot.filePath);
      if (deleted) {
        db.update(screenshots)
          .set({ storageState: "deleted", updatedAt: Date.now() })
          .where(eq(screenshots.id, screenshot.id))
          .run();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failScreenshot(record.id, attempts, message);
    }
  }

  private async failScreenshot(id: number, attempts: number, errorMessage: string): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const exceeded = attempts >= processingConfig.retry.maxAttempts;
    const nextRunAt = exceeded ? null : now + processingConfig.retry.delayMs;
    const status = exceeded ? "failed_permanent" : "failed";

    db.update(screenshots)
      .set({
        ocrStatus: status,
        ocrNextRunAt: nextRunAt,
        updatedAt: now,
      })
      .where(eq(screenshots.id, id))
      .run();

    this.emit("screenshot:ocr:failed", {
      screenshotId: id,
      timestamp: now,
      error: errorMessage.slice(0, 500),
      attempts,
      permanent: exceeded,
    });
  }

  private loadTextRegion(screenshotId: number): KnowledgePayload["textRegion"] | null {
    const db = getDb();
    const link = db
      .select({ nodeId: contextScreenshotLinks.nodeId })
      .from(contextScreenshotLinks)
      .where(eq(contextScreenshotLinks.screenshotId, screenshotId))
      .get();

    if (!link) {
      return null;
    }

    const node = db
      .select({ knowledge: contextNodes.knowledge })
      .from(contextNodes)
      .where(eq(contextNodes.id, link.nodeId))
      .get();

    if (!node?.knowledge) {
      return null;
    }

    try {
      const knowledge = JSON.parse(node.knowledge) as KnowledgePayload;
      return knowledge?.textRegion ?? null;
    } catch (error) {
      logger.warn({ error, screenshotId }, "Failed to parse knowledge payload for OCR");
      return null;
    }
  }
}

export const ocrScheduler = new OcrScheduler();

type PendingOcrRecord = {
  id: number;
  ocrAttempts: number;
  createdAt: number;
  updatedAt: number;
};
