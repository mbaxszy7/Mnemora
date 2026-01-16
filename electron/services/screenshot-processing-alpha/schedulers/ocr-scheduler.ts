import { eq, and, lt, isNotNull } from "drizzle-orm";
import { getDb } from "../../../database";
import { screenshots } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";

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
    // To be implemented in M3: Scan screenshots table for pending OCR
    return null;
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
      // Processing logic following M3
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
    const staleThreshold = Date.now() - processingConfig.scheduler.staleRunningThresholdMs;

    try {
      const result = await db
        .update(screenshots)
        .set({
          ocrStatus: "pending",
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(screenshots.ocrStatus, "running"),
            lt(screenshots.updatedAt, staleThreshold),
            isNotNull(screenshots.filePath)
          )
        );

      if (result.changes > 0) {
        logger.info({ recovered: result.changes }, "Recovered stale OCR screenshots");
      }
    } catch (error) {
      logger.error({ error }, "Failed to recover stale OCR screenshots");
    }
  }
}

export const ocrScheduler = new OcrScheduler();
