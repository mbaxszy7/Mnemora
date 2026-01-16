import { eq, and, lt, isNotNull } from "drizzle-orm";
import { getDb } from "../../../database";
import { screenshots } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";

const logger = getLogger("ocr-scheduler");

export class OcrScheduler extends BaseScheduler {
  private minDelayMs = 2000;
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("OCR scheduler started");
    this.scheduleSoon();
  }

  stop(): void {
    this.isRunning = false;
    this.clearTimer();
    logger.info("OCR scheduler stopped");
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for OCR scheduler");

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
    logger.debug("Starting OCR scheduler cycle");

    try {
      await this.recoverStaleStates();
      // Processing logic following M3
    } catch (error) {
      logger.error({ error }, "Error in OCR scheduler cycle");
    } finally {
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
