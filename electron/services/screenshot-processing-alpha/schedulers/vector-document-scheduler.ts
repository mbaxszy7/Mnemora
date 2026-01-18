import { eq, and, or, lt, isNull, lte, asc, desc } from "drizzle-orm";
import { getDb } from "../../../database";
import { vectorDocuments } from "../../../database/schema";
import { getLogger } from "../../logger";
import { BaseScheduler } from "./base-scheduler";
import { processingConfig } from "../config";
import { screenshotProcessingEventBus } from "../event-bus";
import type { ScreenshotProcessingEventMap } from "../events";
import { vectorDocumentService } from "../vector-document-service";
import { embeddingService } from "../embedding-service";
import { vectorIndexService } from "../vector-index-service";
import { aiRuntimeService } from "../../ai-runtime-service";

const logger = getLogger("vector-document-scheduler");

export class VectorDocumentScheduler extends BaseScheduler {
  protected name = "VectorDocumentScheduler";
  private offDirtyListener: (() => void) | null = null;
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;
  private minDelayMs = 5000;

  constructor() {
    super();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Vector document scheduler started");
    this.emit("scheduler:started", { scheduler: this.name, timestamp: Date.now() });

    this.offDirtyListener = screenshotProcessingEventBus.on("vector-documents:dirty", this.onDirty);
    this.scheduleSoon();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.clearTimer();
    if (this.offDirtyListener) {
      this.offDirtyListener();
      this.offDirtyListener = null;
    }
    logger.info("Vector document scheduler stopped");
    this.emit("scheduler:stopped", { scheduler: this.name, timestamp: Date.now() });
  }

  private readonly onDirty = (event: ScreenshotProcessingEventMap["vector-documents:dirty"]) => {
    this.wake(event.reason);
  };

  wake(reason?: string): void {
    if (!this.isRunning) return;
    logger.debug({ reason }, "Wake requested for vector document scheduler");
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
    let earliest: number | null = null;

    const consider = (val: number | null | undefined) => {
      if (val != null && (earliest === null || val < earliest)) {
        earliest = val;
      }
    };

    const embedding = db
      .select({ nextRunAt: vectorDocuments.embeddingNextRunAt })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          lt(vectorDocuments.embeddingAttempts, processingConfig.retry.maxAttempts)
        )
      )
      .orderBy(asc(vectorDocuments.embeddingNextRunAt))
      .limit(1)
      .get();

    if (embedding) {
      consider(embedding.nextRunAt ?? now);
    }

    const index = db
      .select({ nextRunAt: vectorDocuments.indexNextRunAt })
      .from(vectorDocuments)
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          lt(vectorDocuments.indexAttempts, processingConfig.retry.maxAttempts)
        )
      )
      .orderBy(asc(vectorDocuments.indexNextRunAt))
      .limit(1)
      .get();

    if (index) {
      consider(index.nextRunAt ?? now);
    }

    return earliest;
  }

  protected async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    this.isProcessing = true;
    const cycleStartTs = Date.now();
    logger.debug("Starting vector document scheduler cycle");
    this.emit("scheduler:cycle:start", { scheduler: this.name, timestamp: cycleStartTs });

    let cycleError: string | undefined;
    try {
      await this.recoverStaleStates();

      const records = this.scanPendingRecords();
      if (records.length === 0) {
        return;
      }

      const embeddingRecords = records.filter((r) => r.subtask === "embedding");
      const indexRecords = records.filter((r) => r.subtask === "index");

      const embeddingConcurrency = Math.max(
        1,
        Math.min(aiRuntimeService.getLimit("embedding"), 10)
      );
      const indexConcurrency = 10;

      await this.processGroup(embeddingRecords, embeddingConcurrency);
      await this.processGroup(indexRecords, indexConcurrency);
    } catch (error) {
      cycleError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "Error in vector document scheduler cycle");
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
    const now = Date.now();

    try {
      db.update(vectorDocuments)
        .set({
          embeddingStatus: "pending",
          embeddingNextRunAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(vectorDocuments.embeddingStatus, "running"),
            lt(vectorDocuments.updatedAt, staleThreshold)
          )
        )
        .run();

      db.update(vectorDocuments)
        .set({
          indexStatus: "pending",
          indexNextRunAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(vectorDocuments.indexStatus, "running"),
            eq(vectorDocuments.embeddingStatus, "succeeded"),
            lt(vectorDocuments.updatedAt, staleThreshold)
          )
        )
        .run();
    } catch (error) {
      logger.error({ error }, "Failed to recover stale vector document states");
    }
  }

  private scanPendingRecords(): PendingVectorRecord[] {
    const db = getDb();
    const now = Date.now();
    const limit = 100;
    const sliceLimit = Math.max(1, Math.ceil(limit / 2));

    const mergeUniqueById = <T extends { id: number }>(rows: T[]): T[] => {
      const seen = new Set<number>();
      const out: T[] = [];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
      return out;
    };

    const embeddingNewest = db
      .select({
        id: vectorDocuments.id,
        attempts: vectorDocuments.embeddingAttempts,
        nextRunAt: vectorDocuments.embeddingNextRunAt,
        updatedAt: vectorDocuments.updatedAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          lt(vectorDocuments.embeddingAttempts, processingConfig.retry.maxAttempts),
          or(
            isNull(vectorDocuments.embeddingNextRunAt),
            lte(vectorDocuments.embeddingNextRunAt, now)
          )
        )
      )
      .orderBy(desc(vectorDocuments.updatedAt))
      .limit(sliceLimit)
      .all();

    const embeddingOldest = db
      .select({
        id: vectorDocuments.id,
        attempts: vectorDocuments.embeddingAttempts,
        nextRunAt: vectorDocuments.embeddingNextRunAt,
        updatedAt: vectorDocuments.updatedAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          lt(vectorDocuments.embeddingAttempts, processingConfig.retry.maxAttempts),
          or(
            isNull(vectorDocuments.embeddingNextRunAt),
            lte(vectorDocuments.embeddingNextRunAt, now)
          )
        )
      )
      .orderBy(asc(vectorDocuments.updatedAt))
      .limit(sliceLimit)
      .all();

    const indexNewest = db
      .select({
        id: vectorDocuments.id,
        attempts: vectorDocuments.indexAttempts,
        nextRunAt: vectorDocuments.indexNextRunAt,
        updatedAt: vectorDocuments.updatedAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          lt(vectorDocuments.indexAttempts, processingConfig.retry.maxAttempts),
          or(isNull(vectorDocuments.indexNextRunAt), lte(vectorDocuments.indexNextRunAt, now))
        )
      )
      .orderBy(desc(vectorDocuments.updatedAt))
      .limit(sliceLimit)
      .all();

    const indexOldest = db
      .select({
        id: vectorDocuments.id,
        attempts: vectorDocuments.indexAttempts,
        nextRunAt: vectorDocuments.indexNextRunAt,
        updatedAt: vectorDocuments.updatedAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          lt(vectorDocuments.indexAttempts, processingConfig.retry.maxAttempts),
          or(isNull(vectorDocuments.indexNextRunAt), lte(vectorDocuments.indexNextRunAt, now))
        )
      )
      .orderBy(asc(vectorDocuments.updatedAt))
      .limit(sliceLimit)
      .all();

    const tasks: PendingVectorRecord[] = [];

    for (const row of mergeUniqueById([...embeddingNewest, ...embeddingOldest])) {
      tasks.push({
        id: row.id,
        subtask: "embedding",
        attempts: row.attempts,
        updatedAt: row.updatedAt,
      });
    }

    for (const row of mergeUniqueById([...indexNewest, ...indexOldest])) {
      tasks.push({
        id: row.id,
        subtask: "index",
        attempts: row.attempts,
        updatedAt: row.updatedAt,
      });
    }

    return tasks;
  }

  private splitByLane(
    records: PendingVectorRecord[]
  ): Record<"realtime" | "recovery", PendingVectorRecord[]> {
    const now = Date.now();
    const laneCutoff = now - processingConfig.scheduler.laneRecoveryAgeMs;

    const lanes = records.reduce(
      (acc, record) => {
        if (record.attempts > 0 || record.updatedAt < laneCutoff) {
          acc.recovery.push(record);
        } else {
          acc.realtime.push(record);
        }
        return acc;
      },
      { realtime: [] as PendingVectorRecord[], recovery: [] as PendingVectorRecord[] }
    );

    lanes.realtime.sort((a, b) => b.updatedAt - a.updatedAt);
    lanes.recovery.sort((a, b) => a.updatedAt - b.updatedAt);
    return lanes;
  }

  private async processGroup(records: PendingVectorRecord[], concurrency: number): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const lanes = this.splitByLane(records);
    await this.processInLanes({
      lanes,
      concurrency: Math.max(1, Math.min(concurrency, records.length)),
      laneWeights: { realtime: 3, recovery: 1 },
      handler: async (record, _lane) => {
        void _lane;
        if (record.subtask === "index") {
          await this.processIndexTask(record);
        } else {
          await this.processEmbeddingTask(record);
        }
      },
      onError: (error, record, lane) => {
        logger.error(
          { error, recordId: record.id, subtask: record.subtask, lane },
          "Vector task failed"
        );
      },
    });
  }

  private async processEmbeddingTask(record: PendingVectorRecord): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const attempts = record.attempts + 1;

    const claimed = db
      .update(vectorDocuments)
      .set({
        embeddingStatus: "running",
        embeddingAttempts: attempts,
        embeddingNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(vectorDocuments.id, record.id),
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          lt(vectorDocuments.embeddingAttempts, processingConfig.retry.maxAttempts),
          or(
            isNull(vectorDocuments.embeddingNextRunAt),
            lte(vectorDocuments.embeddingNextRunAt, now)
          )
        )
      )
      .run();

    if (claimed.changes === 0) {
      return;
    }

    const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();
    if (!doc || !doc.refId) {
      return;
    }

    try {
      const text = await vectorDocumentService.buildTextForNode(doc.refId);
      const vector = await embeddingService.embed(text);
      const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

      db.update(vectorDocuments)
        .set({
          embedding: buffer,
          embeddingStatus: "succeeded",
          embeddingNextRunAt: null,
          indexStatus: "pending",
          indexAttempts: 0,
          indexNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(vectorDocuments.id, doc.id), eq(vectorDocuments.embeddingStatus, "running")))
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exceeded = attempts >= processingConfig.retry.maxAttempts;
      const status = exceeded ? "failed_permanent" : "failed";
      const nextRunAt = exceeded ? null : now + processingConfig.retry.delayMs;

      db.update(vectorDocuments)
        .set({
          embeddingStatus: status,
          embeddingNextRunAt: nextRunAt,
          updatedAt: Date.now(),
        })
        .where(
          and(eq(vectorDocuments.id, record.id), eq(vectorDocuments.embeddingStatus, "running"))
        )
        .run();

      logger.error({ error, recordId: record.id, message }, "Failed to generate embedding");
    }
  }

  private async processIndexTask(record: PendingVectorRecord): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const attempts = record.attempts + 1;

    const claimed = db
      .update(vectorDocuments)
      .set({
        indexStatus: "running",
        indexAttempts: attempts,
        indexNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(vectorDocuments.id, record.id),
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          lt(vectorDocuments.indexAttempts, processingConfig.retry.maxAttempts),
          or(isNull(vectorDocuments.indexNextRunAt), lte(vectorDocuments.indexNextRunAt, now))
        )
      )
      .run();

    if (claimed.changes === 0) {
      return;
    }

    const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();
    if (!doc || !doc.embedding) {
      return;
    }

    try {
      const buffer = doc.embedding as Buffer;
      const vector = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

      await vectorIndexService.upsert(doc.id, vector);
      vectorIndexService.requestFlush();

      db.update(vectorDocuments)
        .set({
          indexStatus: "succeeded",
          indexNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(vectorDocuments.id, doc.id), eq(vectorDocuments.indexStatus, "running")))
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exceeded = attempts >= processingConfig.retry.maxAttempts;
      const status = exceeded ? "failed_permanent" : "failed";
      const nextRunAt = exceeded ? null : now + processingConfig.retry.delayMs;

      db.update(vectorDocuments)
        .set({
          indexStatus: status,
          indexNextRunAt: nextRunAt,
          updatedAt: Date.now(),
        })
        .where(and(eq(vectorDocuments.id, record.id), eq(vectorDocuments.indexStatus, "running")))
        .run();

      logger.error({ error, recordId: record.id, message }, "Failed to index vector document");
    }
  }
}

export const vectorDocumentScheduler = new VectorDocumentScheduler();

type PendingVectorRecord = {
  id: number;
  subtask: "embedding" | "index";
  attempts: number;
  updatedAt: number;
};
