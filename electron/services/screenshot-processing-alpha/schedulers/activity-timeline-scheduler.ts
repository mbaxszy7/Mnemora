import { and, asc, desc, eq, gte, isNull, lt, lte, or } from "drizzle-orm";
import { getDb } from "../../../database";
import { activityEvents, activitySummaries, contextNodes } from "../../../database/schema";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import { getLogger } from "../../logger";
import { activityMonitorService } from "../activity-monitor-service";

const logger = getLogger("activity-timeline-scheduler");

export class ActivityTimelineScheduler extends BaseScheduler {
  protected name = "ActivityTimelineScheduler";
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;
  private lastSeedAt = 0;
  private appStartedAt: number | null = null;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.appStartedAt = Date.now();
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
    const db = getDb();
    const now = Date.now();

    let earliest: number | null = null;
    const consider = (val: number | null | undefined) => {
      if (val != null && (earliest === null || val < earliest)) {
        earliest = val;
      }
    };

    const summary = db
      .select({ nextRunAt: activitySummaries.nextRunAt })
      .from(activitySummaries)
      .where(
        and(
          or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed")),
          lt(activitySummaries.attempts, processingConfig.retry.maxAttempts)
        )
      )
      .orderBy(asc(activitySummaries.nextRunAt))
      .limit(1)
      .get();

    if (summary) {
      consider(summary.nextRunAt ?? now);
    }

    if (this.appStartedAt != null) {
      consider(this.lastSeedAt + 60_000);
    }

    return earliest;
  }

  protected async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    this.isProcessing = true;
    const cycleStartTs = Date.now();
    logger.debug("Starting activity timeline scheduler cycle");
    this.emit("scheduler:cycle:start", { scheduler: this.name, timestamp: cycleStartTs });

    let cycleError: string | undefined;
    try {
      await this.recoverStaleStates();
      await this.seedPendingWindows();
      await this.selfHealNoDataWindows();
      await this.processPendingSummaries();
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

  private alignToWindowStart(ts: number): number {
    const windowMs = processingConfig.activitySummary.windowMs;
    return Math.floor(ts / windowMs) * windowMs;
  }

  private async recoverStaleStates(): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const staleThreshold = now - processingConfig.scheduler.staleRunningThresholdMs;

    db.update(activitySummaries)
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

    db.update(activityEvents)
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
  }

  private async seedPendingWindows(): Promise<void> {
    if (!this.appStartedAt) return;

    const now = Date.now();
    if (now - this.lastSeedAt < 60_000) return;

    const db = getDb();
    const windowMs = processingConfig.activitySummary.windowMs;

    const latestNode = db
      .select({ eventTime: contextNodes.eventTime })
      .from(contextNodes)
      .orderBy(desc(contextNodes.eventTime))
      .limit(1)
      .get();

    if (!latestNode) {
      this.lastSeedAt = now;
      return;
    }

    const lastCompleteWindowEnd = this.alignToWindowStart(latestNode.eventTime + windowMs);

    const latestWindow = db
      .select({ windowEnd: activitySummaries.windowEnd })
      .from(activitySummaries)
      .orderBy(desc(activitySummaries.windowEnd))
      .limit(1)
      .get();

    const seedFrom = latestWindow?.windowEnd ?? this.alignToWindowStart(this.appStartedAt);

    let insertedCount = 0;
    for (
      let windowStart = seedFrom;
      windowStart + windowMs <= lastCompleteWindowEnd;
      windowStart += windowMs
    ) {
      const windowEnd = windowStart + windowMs;

      const hasNodes = db
        .select({ id: contextNodes.id })
        .from(contextNodes)
        .where(and(gte(contextNodes.eventTime, windowStart), lt(contextNodes.eventTime, windowEnd)))
        .limit(1)
        .get();

      if (!hasNodes) continue;

      const res = db
        .insert(activitySummaries)
        .values({
          windowStart,
          windowEnd,
          title: null,
          summaryText: "",
          highlights: null,
          stats: null,
          status: "pending",
          attempts: 0,
          nextRunAt: windowEnd,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [activitySummaries.windowStart, activitySummaries.windowEnd],
        })
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

  private async selfHealNoDataWindows(): Promise<void> {
    const db = getDb();
    const now = Date.now();

    const candidates = db
      .select({
        id: activitySummaries.id,
        windowStart: activitySummaries.windowStart,
        windowEnd: activitySummaries.windowEnd,
      })
      .from(activitySummaries)
      .where(and(eq(activitySummaries.status, "no_data"), eq(activitySummaries.title, "No Data")))
      .all();

    if (candidates.length === 0) return;

    for (const cand of candidates) {
      const hasNodes = db
        .select({ id: contextNodes.id })
        .from(contextNodes)
        .where(
          and(
            gte(contextNodes.eventTime, cand.windowStart),
            lt(contextNodes.eventTime, cand.windowEnd)
          )
        )
        .limit(1)
        .get();

      if (!hasNodes) continue;

      db.update(activitySummaries)
        .set({
          status: "pending",
          title: null,
          summaryText: "",
          highlights: null,
          stats: null,
          attempts: 0,
          nextRunAt: now,
          updatedAt: now,
        })
        .where(eq(activitySummaries.id, cand.id))
        .run();
    }
  }

  private async processPendingSummaries(): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const limit = 10;
    const sliceLimit = Math.max(1, Math.ceil(limit / 2));

    const baseWhere = and(
      or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed")),
      or(isNull(activitySummaries.nextRunAt), lte(activitySummaries.nextRunAt, now)),
      lt(activitySummaries.attempts, processingConfig.retry.maxAttempts)
    );

    const newestRows = db
      .select({
        id: activitySummaries.id,
        windowStart: activitySummaries.windowStart,
        windowEnd: activitySummaries.windowEnd,
        attempts: activitySummaries.attempts,
      })
      .from(activitySummaries)
      .where(baseWhere)
      .orderBy(desc(activitySummaries.windowStart))
      .limit(sliceLimit)
      .all();

    const oldestRows = db
      .select({
        id: activitySummaries.id,
        windowStart: activitySummaries.windowStart,
        windowEnd: activitySummaries.windowEnd,
        attempts: activitySummaries.attempts,
      })
      .from(activitySummaries)
      .where(baseWhere)
      .orderBy(asc(activitySummaries.windowStart))
      .limit(sliceLimit)
      .all();

    const rows = [...newestRows, ...oldestRows].filter(
      (row, index, arr) => arr.findIndex((item) => item.id === row.id) === index
    );

    if (rows.length === 0) return;

    const lanes: Record<"realtime" | "recovery", typeof rows> = { realtime: [], recovery: [] };
    for (const row of rows) {
      if (row.attempts > 0) {
        lanes.recovery.push(row);
      } else {
        // fall back to age-based classification for non-retry items
        const ageMs = now - row.windowEnd;
        if (ageMs > processingConfig.scheduler.laneRecoveryAgeMs) {
          lanes.recovery.push(row);
        } else {
          lanes.realtime.push(row);
        }
      }
    }

    const configuredConcurrency = processingConfig.activitySummary.summaryConcurrency;
    const concurrency = Math.max(1, Math.min(configuredConcurrency, rows.length));
    await this.processInLanes({
      lanes,
      concurrency,
      laneWeights: { realtime: 1, recovery: 1 },
      handler: async (row) => {
        const updated = db
          .update(activitySummaries)
          .set({
            status: "running",
            attempts: row.attempts + 1,
            updatedAt: now,
            nextRunAt: null,
          })
          .where(
            and(
              eq(activitySummaries.id, row.id),
              or(eq(activitySummaries.status, "pending"), eq(activitySummaries.status, "failed"))
            )
          )
          .run();

        if (updated.changes === 0) return;

        const success = await activityMonitorService.generateWindowSummary(
          row.windowStart,
          row.windowEnd
        );
        if (!success) {
          const nextRunAt = Date.now() + processingConfig.retry.delayMs;
          db.update(activitySummaries)
            .set({
              status: "failed",
              nextRunAt,
              updatedAt: Date.now(),
            })
            .where(eq(activitySummaries.id, row.id))
            .run();
        }
      },
    });
  }
}

export const activityTimelineScheduler = new ActivityTimelineScheduler();
