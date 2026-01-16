import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../../../database";
import { batches } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";

const logger = getLogger("batch-vlm-scheduler");

export class BatchVlmScheduler extends BaseScheduler {
  private minDelayMs = 2000;
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Batch VLM scheduler started");
    this.scheduleSoon();
  }

  stop(): void {
    this.isRunning = false;
    this.clearTimer();
    logger.info("Batch VLM scheduler stopped");
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for batch VLM scheduler");

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
    // To be implemented in M2: Scan batches table for pending VLM
    return null;
  }

  protected async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    this.isProcessing = true;
    logger.debug("Starting batch VLM scheduler cycle");

    try {
      await this.recoverStaleStates();
      // Processing logic following M2
    } catch (error) {
      logger.error({ error }, "Error in batch VLM scheduler cycle");
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
        .update(batches)
        .set({
          vlmStatus: "pending",
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
}

export const batchVlmScheduler = new BatchVlmScheduler();
