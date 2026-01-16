import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import { getLogger } from "../../logger";

const logger = getLogger("activity-timeline-scheduler");

export class ActivityTimelineScheduler extends BaseScheduler {
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Activity timeline scheduler started");
    this.scheduleSoon();
  }

  stop(): void {
    this.isRunning = false;
    this.clearTimer();
    logger.info("Activity timeline scheduler stopped");
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for activity timeline scheduler");
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
    if (!this.isRunning || this.isProcessing) return;
    this.isProcessing = true;
    logger.debug("Starting activity timeline scheduler cycle");

    try {
      // Logic to be implemented in M6
    } catch (error) {
      logger.error({ error }, "Error in activity timeline scheduler cycle");
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
}

export const activityTimelineScheduler = new ActivityTimelineScheduler();
