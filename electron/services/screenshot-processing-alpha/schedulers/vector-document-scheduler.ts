import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import { getLogger } from "../../logger";

const logger = getLogger("vector-document-scheduler");

export class VectorDocumentScheduler extends BaseScheduler {
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Vector document scheduler started");
    this.scheduleSoon();
  }

  stop(): void {
    this.isRunning = false;
    this.clearTimer();
    logger.info("Vector document scheduler stopped");
  }

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for vector document scheduler");
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
    // Skeleton: logic to be implemented in M5
    return null;
  }

  protected async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;
    this.isProcessing = true;
    logger.debug("Starting vector document scheduler cycle");

    try {
      // Logic to be implemented in M5
    } catch (error) {
      logger.error({ error }, "Error in vector document scheduler cycle");
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

export const vectorDocumentScheduler = new VectorDocumentScheduler();
