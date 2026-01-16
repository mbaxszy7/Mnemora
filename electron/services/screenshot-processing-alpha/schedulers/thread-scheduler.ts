import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../../../database";
import { batches } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";

const logger = getLogger("thread-scheduler");

export class ThreadScheduler extends BaseScheduler {
  protected name = "ThreadScheduler";
  private minDelayMs = 2000;
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Thread scheduler started");
    this.emit("scheduler:started", { scheduler: this.name, timestamp: Date.now() });
    this.scheduleSoon();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.clearTimer();
    logger.info("Thread scheduler stopped");
    this.emit("scheduler:stopped", { scheduler: this.name, timestamp: Date.now() });
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for thread scheduler");
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
    // To be implemented in M4: Scan for pending thread assignments
    return null;
  }

  protected async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    this.isProcessing = true;
    const cycleStartTs = Date.now();
    logger.debug("Starting thread scheduler cycle");
    this.emit("scheduler:cycle:start", { scheduler: this.name, timestamp: cycleStartTs });

    let cycleError: string | undefined;
    try {
      await this.recoverStaleStates();
      // Processing logic following M4
    } catch (error) {
      cycleError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Error in thread scheduler cycle");
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
          threadLlmStatus: "pending",
          updatedAt: Date.now(),
        })
        .where(and(eq(batches.threadLlmStatus, "running"), lt(batches.updatedAt, staleThreshold)));

      if (result.changes > 0) {
        logger.info({ recovered: result.changes }, "Recovered stale thread assignments");
      }
    } catch (error) {
      logger.error({ error }, "Failed to recover stale thread assignments");
    }
  }
}

export const threadScheduler = new ThreadScheduler();
