import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import { getLogger } from "../../logger";

const logger = getLogger("activity-timeline-scheduler");

export class ActivityTimelineScheduler extends BaseScheduler {
  protected name = "ActivityTimelineScheduler";
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Activity timeline scheduler started");
    this.emit("scheduler:started", { scheduler: this.name, timestamp: Date.now() });
    this.scheduleSoon();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.clearTimer();
    logger.info("Activity timeline scheduler stopped");
    this.emit("scheduler:stopped", { scheduler: this.name, timestamp: Date.now() });
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for activity timeline scheduler");
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
    return 5000;
  }

  protected computeEarliestNextRun(): number | null {
    // Skeleton: logic to be implemented in M6
    return null;
  }

  protected async runCycle(): Promise<void> {
    this.isProcessing = true;
    const cycleStartTs = Date.now();
    logger.debug("Starting activity timeline scheduler cycle");
    this.emit("scheduler:cycle:start", { scheduler: this.name, timestamp: cycleStartTs });

    let cycleError: string | undefined;
    try {
      // Logic to be implemented in M6
    } catch (error) {
      cycleError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Error in activity timeline scheduler cycle");
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
}

export const activityTimelineScheduler = new ActivityTimelineScheduler();
