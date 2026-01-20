import { eq, and, lt, or, isNull, lte, asc, desc } from "drizzle-orm";
import { getDb } from "../../../database";
import { batches, contextNodes } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import { threadLlmService } from "../thread-llm-service";
import { threadRepository } from "../thread-repository";
import { vectorDocumentScheduler } from "./vector-document-scheduler";
import { vectorDocumentService } from "../vector-document-service";

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
    const db = getDb();
    const now = Date.now();

    const row = db
      .select({ nextRunAt: batches.threadLlmNextRunAt })
      .from(batches)
      .where(
        and(
          eq(batches.vlmStatus, "succeeded"),
          or(eq(batches.threadLlmStatus, "pending"), eq(batches.threadLlmStatus, "failed")),
          lt(batches.threadLlmAttempts, processingConfig.retry.maxAttempts),
          or(isNull(batches.threadLlmNextRunAt), lte(batches.threadLlmNextRunAt, now))
        )
      )
      .orderBy(asc(batches.threadLlmNextRunAt))
      .limit(1)
      .get();

    if (!row) {
      return null;
    }

    return row.nextRunAt ?? now;
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

      const inactiveChanged = threadRepository.markInactiveThreads();
      if (inactiveChanged > 0) {
        logger.info({ changed: inactiveChanged }, "Marked inactive threads");
      }

      const records = this.scanPendingRecords();
      if (records.length === 0) {
        return;
      }

      const lanes = this.splitByLane(records);
      const concurrency = 1;

      await this.processInLanes({
        lanes,
        concurrency,
        laneWeights: { realtime: 3, recovery: 1 },
        handler: async (record) => {
          await this.processOneBatch(record);
        },
        onError: (error, record) => {
          logger.error({ error, batchDbId: record.id }, "Unhandled error processing thread batch");
        },
      });
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
      const result = db
        .update(batches)
        .set({
          threadLlmStatus: "pending",
          threadLlmNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(batches.threadLlmStatus, "running"), lt(batches.updatedAt, staleThreshold)))
        .run();

      if (result.changes > 0) {
        logger.info({ recovered: result.changes }, "Recovered stale thread assignments");
      }
    } catch (error) {
      logger.error({ error }, "Failed to recover stale thread assignments");
    }
  }

  private scanPendingRecords(): PendingThreadBatchRecord[] {
    const db = getDb();
    const now = Date.now();
    const limit = 100;
    const sliceLimit = Math.max(1, Math.ceil(limit / 2));

    const baseWhere = and(
      eq(batches.vlmStatus, "succeeded"),
      or(eq(batches.threadLlmStatus, "pending"), eq(batches.threadLlmStatus, "failed")),
      lt(batches.threadLlmAttempts, processingConfig.retry.maxAttempts),
      or(isNull(batches.threadLlmNextRunAt), lte(batches.threadLlmNextRunAt, now))
    );

    const newest = db
      .select({
        id: batches.id,
        threadLlmAttempts: batches.threadLlmAttempts,
        updatedAt: batches.updatedAt,
      })
      .from(batches)
      .where(baseWhere)
      .orderBy(desc(batches.updatedAt))
      .limit(sliceLimit)
      .all();

    const oldest = db
      .select({
        id: batches.id,
        threadLlmAttempts: batches.threadLlmAttempts,
        updatedAt: batches.updatedAt,
      })
      .from(batches)
      .where(baseWhere)
      .orderBy(asc(batches.updatedAt))
      .limit(sliceLimit)
      .all();

    const merged = new Map<number, PendingThreadBatchRecord>();
    for (const row of [...newest, ...oldest]) {
      merged.set(row.id, {
        id: row.id,
        threadLlmAttempts: row.threadLlmAttempts,
        updatedAt: row.updatedAt,
      });
    }

    return Array.from(merged.values());
  }

  private splitByLane(
    records: PendingThreadBatchRecord[]
  ): Record<"realtime" | "recovery", PendingThreadBatchRecord[]> {
    const now = Date.now();
    const laneCutoff = now - processingConfig.scheduler.laneRecoveryAgeMs;

    const lanes = records.reduce(
      (acc, record) => {
        if (record.threadLlmAttempts > 0 || record.updatedAt < laneCutoff) {
          acc.recovery.push(record);
        } else {
          acc.realtime.push(record);
        }
        return acc;
      },
      { realtime: [] as PendingThreadBatchRecord[], recovery: [] as PendingThreadBatchRecord[] }
    );

    lanes.realtime.sort((a, b) => b.updatedAt - a.updatedAt);
    lanes.recovery.sort((a, b) => a.updatedAt - b.updatedAt);
    return lanes;
  }

  private async processOneBatch(record: PendingThreadBatchRecord): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const attempts = record.threadLlmAttempts + 1;

    const claimed = db
      .update(batches)
      .set({
        threadLlmStatus: "running",
        threadLlmAttempts: attempts,
        threadLlmNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(batches.id, record.id),
          eq(batches.vlmStatus, "succeeded"),
          or(eq(batches.threadLlmStatus, "pending"), eq(batches.threadLlmStatus, "failed")),
          lt(batches.threadLlmAttempts, processingConfig.retry.maxAttempts),
          or(isNull(batches.threadLlmNextRunAt), lte(batches.threadLlmNextRunAt, now))
        )
      )
      .run();

    if (claimed.changes === 0) {
      return;
    }

    const batchNodes = db
      .select({
        id: contextNodes.id,
        title: contextNodes.title,
        summary: contextNodes.summary,
        eventTime: contextNodes.eventTime,
        threadId: contextNodes.threadId,
        threadSnapshot: contextNodes.threadSnapshot,
        appContext: contextNodes.appContext,
        knowledge: contextNodes.knowledge,
        stateSnapshot: contextNodes.stateSnapshot,
        keywords: contextNodes.keywords,
      })
      .from(contextNodes)
      .where(eq(contextNodes.batchId, record.id))
      .orderBy(asc(contextNodes.eventTime))
      .all();

    if (batchNodes.length === 0) {
      await this.failBatch(record.id, attempts, "No context nodes found for batch");
      return;
    }

    const missingThreadIds = batchNodes.some((n) => !n.threadId);

    try {
      if (!missingThreadIds) {
        const finalized = threadRepository.finalizeBatchWithExistingAssignments({
          batchDbId: record.id,
          batchNodesAsc: batchNodes,
        });

        await Promise.all(
          batchNodes.map((node) => vectorDocumentService.upsertForContextNode(node.id))
        );

        for (const tid of finalized.affectedThreadIds) {
          this.emit("batch:thread:succeeded", {
            batchId: record.id,
            threadId: tid,
            timestamp: now,
          });
        }

        vectorDocumentScheduler.wake("thread:finalized");
        return;
      }

      logger.info({ batchDbId: record.id, nodeCount: batchNodes.length }, "Calling Thread LLM");

      const { output } = await threadLlmService.assignForBatch({
        batchDbId: record.id,
        batchNodes,
      });

      const applied = threadRepository.applyThreadLlmResult({
        batchDbId: record.id,
        batchNodesAsc: batchNodes,
        output,
      });

      await Promise.all(
        batchNodes.map((node) => vectorDocumentService.upsertForContextNode(node.id))
      );

      for (const tid of applied.affectedThreadIds) {
        this.emit("batch:thread:succeeded", {
          batchId: record.id,
          threadId: tid,
          timestamp: now,
        });
      }

      vectorDocumentScheduler.wake("thread:assigned");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failBatch(record.id, attempts, message);
    }
  }

  private async failBatch(
    batchDbId: number,
    attempts: number,
    errorMessage: string
  ): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const exceeded = attempts >= processingConfig.retry.maxAttempts;
    const nextRunAt = exceeded ? null : now + processingConfig.retry.delayMs;
    const status = exceeded ? "failed_permanent" : "failed";

    db.update(batches)
      .set({
        threadLlmStatus: status,
        threadLlmErrorMessage: errorMessage.slice(0, 500),
        threadLlmNextRunAt: nextRunAt,
        updatedAt: now,
      })
      .where(eq(batches.id, batchDbId))
      .run();

    this.emit("batch:thread:failed", { batchId: batchDbId, error: errorMessage, timestamp: now });
  }
}

export const threadScheduler = new ThreadScheduler();

type PendingThreadBatchRecord = {
  id: number;
  threadLlmAttempts: number;
  updatedAt: number;
};
