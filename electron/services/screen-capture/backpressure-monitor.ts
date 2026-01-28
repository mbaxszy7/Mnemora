import { eq, sql } from "drizzle-orm";
import { getDb } from "../../database";
import { batches } from "../../database/schema";
import { getLogger } from "../logger";
import { processingConfig } from "../screenshot-processing/config";
import { screenCaptureEventBus } from "./event-bus";

const logger = getLogger("backpressure-monitor");

export interface BackpressureLevel {
  level: number;
  intervalMultiplier: number;
  phashThreshold: number;
}

export class BackpressureMonitor {
  private currentLevel = 0;
  private lastLevelChangeTs = 0;
  private checkTimer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private readonly recoveryGracePeriodMs = processingConfig.backpressure.recoveryHysteresisMs;

  constructor() {}

  start(): void {
    if (this.checkTimer) return;
    logger.info("Backpressure monitor started");
    this.checkTimer = setInterval(
      () => this.check(),
      processingConfig.backpressure.checkIntervalMs
    );
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    logger.info("Backpressure monitor stopped");
  }

  private async check(): Promise<void> {
    if (this.isChecking) {
      return;
    }

    this.isChecking = true;
    try {
      const pendingCount = await this.getPendingVlmCount();
      const newLevel = this.calculateLevel(pendingCount);

      if (newLevel !== this.currentLevel) {
        await this.handleLevelChange(newLevel);
      }
    } catch (error) {
      logger.error({ error }, "Error during backpressure check");
    } finally {
      this.isChecking = false;
    }
  }

  private async getPendingVlmCount(): Promise<number> {
    const db = getDb();
    const row = await db
      .select({ count: sql<number>`count(*)` })
      .from(batches)
      .where(eq(batches.vlmStatus, "pending"))
      .get();
    return Number(row?.count ?? 0);
  }

  private calculateLevel(pendingCount: number): number {
    const { levels } = processingConfig.backpressure;

    for (let i = 0; i < levels.length; i++) {
      if (pendingCount <= levels[i].maxPending) {
        return i;
      }
    }
    return levels.length - 1;
  }

  private async handleLevelChange(newLevel: number): Promise<void> {
    const now = Date.now();

    // Hysteresis: Only allow recovery (going to a lower level) if grace period has passed
    if (newLevel < this.currentLevel) {
      if (now - this.lastLevelChangeTs < this.recoveryGracePeriodMs) {
        logger.debug(
          { currentLevel: this.currentLevel, requestedLevel: newLevel },
          "Backpressure recovery deferred due to hysteresis"
        );
        return;
      }
    }

    const oldLevel = this.currentLevel;
    this.currentLevel = newLevel;
    this.lastLevelChangeTs = now;

    const levelConfig = processingConfig.backpressure.levels[newLevel];

    logger.info(
      {
        oldLevel,
        newLevel,
        multiplier: levelConfig.intervalMultiplier,
        phash: levelConfig.phashThreshold,
      },
      "Backpressure level changed"
    );

    screenCaptureEventBus.emit("backpressure:level-changed", {
      type: "backpressure:level-changed",
      timestamp: now,
      level: newLevel,
      config: {
        intervalMultiplier: levelConfig.intervalMultiplier,
        phashThreshold: levelConfig.phashThreshold,
      },
    });
  }

  getCurrentLevel(): number {
    return this.currentLevel;
  }
}

export const backpressureMonitor = new BackpressureMonitor();
