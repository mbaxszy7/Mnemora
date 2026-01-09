/**
 * Activity Timeline Scheduler
 *
 * Independent scheduler for generating 20-minute activity summaries.
 * Runs on its own timer, separate from ReconcileLoop.
 *
 * Responsibilities:
 * - Seed pending windows every 20 minutes
 * - Process pending summary generation tasks
 * - Process pending event details generation tasks (on-demand triggered)
 * - Recover stale running states for activity tables
 */

import { eq, and, lt, or, isNull, lte, desc, asc, gte, inArray } from "drizzle-orm";
import { getDb } from "../../database";
import { activitySummaries, activityEvents, screenshots } from "../../database/schema";
import { getLogger } from "../logger";
import { processingConfig } from "./config";
import { activityMonitorService } from "./activity-monitor-service";
import { BaseScheduler } from "./base-scheduler";

const logger = getLogger("activity-timeline-scheduler");

/**
 * ActivityTimelineScheduler runs independently of ReconcileLoop.
 * It manages the lifecycle of activity summary and event details generation.
 */
export class ActivityTimelineScheduler extends BaseScheduler {
  private lastSeedAt = 0;
  private appStartedAt: number | null = null;

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.appStartedAt = Date.now();
    logger.info("Activity timeline scheduler started");

    // Run first cycle soon after startup
    this.scheduleSoon();
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.isRunning = false;
    this.clearTimer();
    logger.info("Activity timeline scheduler stopped");
  }

  protected getDefaultIntervalMs(): number {
    return processingConfig.activitySummary.generationIntervalMs;
  }

  protected getMinDelayMs(): number {
    return 10000;
  }

  protected onScheduledNext(delayMs: number, earliestNextRun: number | null): void {
    logger.debug({ delayMs, earliestNextRun }, "Scheduled next timeline cycle");
  }

  /**
   * Compute the earliest nextRunAt across pending activity_summaries and activity_events
   */
  protected computeEarliestNextRun(): number | null {
    const db = getDb();
    const now = Date.now();
    let earliest: number | null = null;

    const consider = (val: number | null | undefined) => {
      if (val != null && (earliest === null || val < earliest)) {
        earliest = val;
      }
    };

    // Check activity_summaries
    const summary = db
      .select({ nextRunAt: activitySummaries.nextRunAt })
      .from(activitySummaries)
      .where(
        and(
          or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed")),
          lt(activitySummaries.attempts, processingConfig.scheduler.retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(activitySummaries.nextRunAt))
      .limit(1)
      .get();
    if (summary) {
      consider(summary.nextRunAt ?? now);
    } else {
      // Check activity_events only when there are no pending summaries
      const eventDetails = db
        .select({ nextRunAt: activityEvents.detailsNextRunAt })
        .from(activityEvents)
        .where(
          and(
            or(
              eq(activityEvents.detailsStatus, "pending"),
              eq(activityEvents.detailsStatus, "failed")
            ),
            lt(activityEvents.detailsAttempts, processingConfig.scheduler.retryConfig.maxAttempts)
          )
        )
        .orderBy(asc(activityEvents.detailsNextRunAt))
        .limit(1)
        .get();
      if (eventDetails) {
        consider(eventDetails.nextRunAt ?? now);
      }
    }

    // Also consider seed timing
    if (this.appStartedAt != null) {
      consider(this.lastSeedAt + 60_000);
    }

    return earliest;
  }

  /**
   * Main cycle: recover stale states, seed windows, process pending tasks
   */
  protected override async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    this.isProcessing = true;
    logger.debug("Starting timeline scheduler cycle");

    try {
      // 1. Recover stale running states
      await this.recoverStaleStates();

      // 2. Seed pending windows if capture is active
      await this.seedPendingWindows();

      // 3. Self-heal incorrect "No Data" windows
      await this.selfHealNoDataWindows();

      // 4. Process pending summaries
      await this.processPendingSummaries();

      // 5. Process pending event details
      if (!this.hasPendingSummary()) {
        await this.processPendingEventDetails();
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Error in timeline scheduler cycle"
      );
    } finally {
      this.isProcessing = false;

      if (this.isRunning) {
        this.scheduleNext();
      }
    }
  }

  private hasPendingSummary(): boolean {
    const db = getDb();
    const row = db
      .select({ id: activitySummaries.id })
      .from(activitySummaries)
      .where(
        and(
          or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed")),
          lt(activitySummaries.attempts, processingConfig.scheduler.retryConfig.maxAttempts)
        )
      )
      .limit(1)
      .get();

    return row != null;
  }

  /**
   * Recover activity_summaries and activity_events stuck in 'running' state
   */
  private async recoverStaleStates(): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const staleThreshold = now - processingConfig.scheduler.staleRunningThresholdMs;

    // Recover activity_summaries
    const staleSummaries = db
      .update(activitySummaries)
      .set({
        status: "pending",
        nextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(activitySummaries.status, "running"),
          lt(activitySummaries.updatedAt, staleThreshold)
        )
      )
      .run();

    if (staleSummaries.changes > 0) {
      logger.info({ count: staleSummaries.changes }, "Recovered stale running activity summaries");
    }

    // Recover activity_events.detailsStatus
    const staleEventDetails = db
      .update(activityEvents)
      .set({
        detailsStatus: "pending",
        detailsNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(activityEvents.detailsStatus, "running"),
          lt(activityEvents.updatedAt, staleThreshold)
        )
      )
      .run();

    if (staleEventDetails.changes > 0) {
      logger.info(
        { count: staleEventDetails.changes },
        "Recovered stale running activity event details"
      );
    }
  }

  /**
   * Automatically reset "No Data" windows that actually contain screenshots.
   * This is a self-healing mechanism for windows incorrectly marked as empty
   * due to race conditions or interrupted processing.
   */
  private async selfHealNoDataWindows(): Promise<void> {
    const db = getDb();
    const now = Date.now();

    // Find windows marked as "No Data"
    const candidates = db
      .select({
        id: activitySummaries.id,
        windowStart: activitySummaries.windowStart,
        windowEnd: activitySummaries.windowEnd,
      })
      .from(activitySummaries)
      .where(and(eq(activitySummaries.title, "No Data"), eq(activitySummaries.status, "succeeded")))
      .all();

    if (candidates.length === 0) return;

    let resetCount = 0;
    let deleteCount = 0;
    for (const cand of candidates) {
      // Check if there are ANY screenshots in this window
      const hasScreenshots = db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(and(gte(screenshots.ts, cand.windowStart), lt(screenshots.ts, cand.windowEnd)))
        .limit(1)
        .get();

      if (hasScreenshots) {
        // Reset to pending so it can be re-summarized
        db.update(activitySummaries)
          .set({
            status: "pending",
            title: null,
            summary: "",
            highlights: null,
            stats: null,
            attempts: 0,
            nextRunAt: now,
            updatedAt: now,
          })
          .where(eq(activitySummaries.id, cand.id))
          .run();
        resetCount++;
      } else {
        // Genuinely empty window, delete it to keep timeline clean
        db.delete(activitySummaries).where(eq(activitySummaries.id, cand.id)).run();
        deleteCount++;
      }
    }

    if (resetCount > 0 || deleteCount > 0) {
      logger.info(
        { resetCount, deleteCount },
        "Self-healed window summaries: reset some and deleted others"
      );
    }
  }

  /**
   * Align timestamp to previous 10-minute boundary (floor/round down)
   * e.g., 12:22 → 12:20, 12:34 → 12:30
   * This ensures screenshots taken immediately after app start are included
   */
  private alignToWindowStart(ts: number): number {
    const d = new Date(ts);
    d.setSeconds(0, 0);
    const mins = d.getMinutes();
    // Align to 10-minute boundaries (floor)
    const alignedMins = Math.floor(mins / 10) * 10;
    d.setMinutes(alignedMins);
    return d.getTime();
  }

  /**
   * Seed pending windows for completed time periods
   */
  private async seedPendingWindows(): Promise<void> {
    if (!this.appStartedAt) {
      return;
    }

    const now = Date.now();
    const intervalMs = processingConfig.activitySummary.generationIntervalMs;

    // Only seed once per minute to avoid redundant work
    if (now - this.lastSeedAt < 60_000) {
      return;
    }

    const db = getDb();

    // Only seed windows that have completed
    const lastCompleteWindowEnd = this.alignToWindowStart(now);

    // Find latest existing window end
    const latest = db
      .select({ windowEnd: activitySummaries.windowEnd })
      .from(activitySummaries)
      .orderBy(desc(activitySummaries.windowEnd))
      .limit(1)
      .get();
    const latestWindowEnd = latest?.windowEnd ?? 0;

    // Start from latest existing window end
    const seedFrom =
      latestWindowEnd > 0 ? latestWindowEnd : this.alignToWindowStart(this.appStartedAt);

    let insertedCount = 0;
    for (
      let windowStart = seedFrom;
      windowStart + intervalMs <= lastCompleteWindowEnd;
      windowStart += intervalMs
    ) {
      const windowEnd = windowStart + intervalMs;

      // Check if there are any screenshots in this window before seeding
      const hasScreenshots = db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(and(gte(screenshots.ts, windowStart), lt(screenshots.ts, windowEnd)))
        .limit(1)
        .get();

      if (!hasScreenshots) {
        continue;
      }

      // 计算当前窗口内截图总数与“VLM 已完成”的截图数。
      // 这里的“VLM 已完成”定义为：
      // - vlmStatus == succeeded / failed_permanent
      // - 或 vlmStatus == failed 但已经达到最大重试次数（vlmAttempts >= maxAttempts）
      // 目的：让 seed 的 completed 判定不再单纯依赖时间（windowEnd），而是依赖 VLM 进度。

      const totalScreenshotCount = db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(and(gte(screenshots.ts, windowStart), lt(screenshots.ts, windowEnd)))
        .all().length;

      const completedVlmCount = db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(
          and(
            gte(screenshots.ts, windowStart),
            lt(screenshots.ts, windowEnd),
            or(
              inArray(screenshots.vlmStatus, ["succeeded", "failed_permanent"]),
              and(
                eq(screenshots.vlmStatus, "failed"),
                gte(screenshots.vlmAttempts, processingConfig.scheduler.retryConfig.maxAttempts)
              )
            )
          )
        )
        .all().length;

      // 允许在 VLM 有“足够进展”时就 seed window。
      // 这样 timeline 上能尽早出现该 window，并在 summary 生成逻辑里显示为 "Processing"，
      // 而不是因为等待“100% VLM 完成”导致 window 长时间不出现（或卡住）。
      const minCompletionRatio = 0.7;
      const completionRatio =
        totalScreenshotCount > 0 ? completedVlmCount / totalScreenshotCount : 0;
      if (completionRatio < minCompletionRatio) {
        continue;
      }

      const idempotencyKey = `win_${windowStart}_${windowEnd}`;
      const nextRunAt = windowEnd;

      const res = db
        .insert(activitySummaries)
        .values({
          windowStart,
          windowEnd,
          idempotencyKey,
          title: null,
          summary: "",
          highlights: null,
          stats: null,
          status: "pending",
          attempts: 0,
          nextRunAt,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: activitySummaries.idempotencyKey })
        .run();

      if (res.changes > 0) {
        insertedCount++;
      }
    }

    if (insertedCount > 0) {
      logger.info({ count: insertedCount }, "Seeded pending activity windows");
    }

    this.lastSeedAt = now;
  }

  /**
   * Process pending activity summaries
   */
  private async processPendingSummaries(): Promise<void> {
    const db = getDb();
    const now = Date.now();

    const pendingRows = db
      .select({
        id: activitySummaries.id,
        windowStart: activitySummaries.windowStart,
        windowEnd: activitySummaries.windowEnd,
        attempts: activitySummaries.attempts,
      })
      .from(activitySummaries)
      .where(
        and(
          or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed")),
          or(isNull(activitySummaries.nextRunAt), lte(activitySummaries.nextRunAt, now)),
          lt(activitySummaries.attempts, processingConfig.scheduler.retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(activitySummaries.windowStart))
      .limit(5) // Process up to 5 at a time
      .all();

    await Promise.allSettled(pendingRows.map((row) => this.processSummaryRecord(row)));
  }

  /**
   * Process a single summary record
   */
  private async processSummaryRecord(record: {
    id: number;
    windowStart: number;
    windowEnd: number;
    attempts: number;
  }): Promise<void> {
    const db = getDb();
    const claimedAttempts = record.attempts + 1;

    try {
      // Claim the record
      const claim = db
        .update(activitySummaries)
        .set({
          status: "running",
          attempts: claimedAttempts,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(activitySummaries.id, record.id),
            or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed"))
          )
        )
        .run();

      if (claim.changes === 0) {
        return; // Already claimed by another process
      }

      logger.debug(
        { windowStart: record.windowStart, windowEnd: record.windowEnd },
        "Processing activity summary"
      );

      await activityMonitorService.generateWindowSummary(record.windowStart, record.windowEnd);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isPermanent = claimedAttempts >= processingConfig.scheduler.retryConfig.maxAttempts;
      const nextRunAt = isPermanent ? null : this.calculateNextRun();

      db.update(activitySummaries)
        .set({
          status: isPermanent ? "failed_permanent" : "failed",
          attempts: claimedAttempts,
          nextRunAt,
          errorMessage,
          updatedAt: Date.now(),
        })
        .where(eq(activitySummaries.id, record.id))
        .run();

      logger.warn(
        { id: record.id, error: errorMessage, attempts: claimedAttempts },
        "Activity summary generation failed"
      );
    }
  }

  /**
   * Process pending event details (on-demand only, triggered by getEventDetails)
   */
  private async processPendingEventDetails(): Promise<void> {
    const db = getDb();
    const now = Date.now();

    const pendingRows = db
      .select({
        id: activityEvents.id,
        title: activityEvents.title,
        detailsAttempts: activityEvents.detailsAttempts,
      })
      .from(activityEvents)
      .where(
        and(
          or(
            eq(activityEvents.detailsStatus, "pending"),
            eq(activityEvents.detailsStatus, "failed")
          ),
          or(isNull(activityEvents.detailsNextRunAt), lte(activityEvents.detailsNextRunAt, now)),
          lt(activityEvents.detailsAttempts, processingConfig.scheduler.retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(activityEvents.updatedAt))
      .limit(2) // Process up to 2 at a time
      .all();

    await Promise.allSettled(pendingRows.map((row) => this.processEventDetailsRecord(row)));
  }

  /**
   * Process a single event details record
   */
  private async processEventDetailsRecord(record: {
    id: number;
    title: string;
    detailsAttempts: number;
  }): Promise<void> {
    const db = getDb();
    const claimedAttempts = record.detailsAttempts + 1;

    try {
      // Claim the record
      const claim = db
        .update(activityEvents)
        .set({
          detailsStatus: "running",
          detailsAttempts: claimedAttempts,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(activityEvents.id, record.id),
            or(
              eq(activityEvents.detailsStatus, "pending"),
              eq(activityEvents.detailsStatus, "failed")
            )
          )
        )
        .run();

      if (claim.changes === 0) {
        return; // Already claimed
      }

      logger.debug({ eventId: record.id, title: record.title }, "Processing event details");

      const success = await activityMonitorService.generateEventDetails(record.id);

      if (!success) {
        throw new Error("Event details generation returned false");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isPermanent = claimedAttempts >= processingConfig.scheduler.retryConfig.maxAttempts;
      const nextRunAt = isPermanent ? null : this.calculateNextRun();

      db.update(activityEvents)
        .set({
          detailsStatus: isPermanent ? "failed_permanent" : "failed",
          detailsAttempts: claimedAttempts,
          detailsNextRunAt: nextRunAt,
          detailsErrorMessage: errorMessage,
          updatedAt: Date.now(),
        })
        .where(eq(activityEvents.id, record.id))
        .run();

      logger.warn(
        { id: record.id, error: errorMessage, attempts: claimedAttempts },
        "Event details generation failed"
      );
    }
  }

  /**
   * Calculate next run time - fixed 2 minute delay
   */
  private calculateNextRun(): number {
    return Date.now() + 2 * 60 * 1000; // 2 minutes
  }
}

export const activityTimelineScheduler = new ActivityTimelineScheduler();
