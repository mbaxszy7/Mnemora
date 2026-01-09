import { eq, and, or, lt, isNull, lte, asc } from "drizzle-orm";
import { getDb } from "../../database";
import { vectorDocuments } from "../../database/schema";
import { getLogger } from "../logger";
import { processingConfig } from "./config";
import { aiRuntimeService } from "../ai-runtime-service";
import {
  onVectorDocumentsDirty,
  vectorDocumentService,
  type VectorDocumentDirtyEvent,
} from "./vector-document-service";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";
import type { PendingRecord } from "./types";
import { BaseScheduler } from "./base-scheduler";

const logger = getLogger("vector-document-scheduler");

/**
 * VectorDocumentScheduler：`vector_documents` 的后台调度器。
 *
 * 背景：项目里 vector 的目的是做“语义检索”。数据链路是：
 * - ReconcileLoop 产出/更新 context node（VLM 扩写新节点、merge 改写目标节点）
 * - VectorDocumentService.upsertForContextNode() 负责把变更写入 `vector_documents`，并把任务状态置为 pending（入队）
 * - 本调度器扫描 pending/failed 的记录，推进两段子任务：embedding 与 index
 * - VectorIndexService 负责维护本地 HNSW 索引（hnswlib）并落盘
 * - ContextSearchService 查询时：query embedding -> HNSW 搜索 -> docId 映射 refId -> context_nodes
 *
 * `vector_documents` 两段状态机：
 * - embedding 子任务：`embeddingStatus/embeddingAttempts/embeddingNextRunAt/embedding`
 * - index 子任务：`indexStatus/indexAttempts/indexNextRunAt`
 *
 * 调度语义（核心原则）：
 * - “任务是否 due”由 DB 状态机决定：pending/failed 且 (nextRunAt 为空或到期) 且 attempts < maxAttempts。
 * - 并发安全通过 claim（UPDATE...WHERE status in pending/failed）实现；claim 失败说明被其它并发单元抢走。
 * - 失败重试会写 nextRunAt（指数退避 + jitter）；达到上限后进入 failed_permanent，不再被扫描。
 * - 崩溃恢复：running 超过 staleRunningThresholdMs 会被回滚为 pending。
 *
 * wake / 定时策略：
 * - start() 后 scheduleSoon（1s）跑首轮。
 * - dirty 回调触发 wake()，用于“加速”而不是“唯一驱动”；即使没有 wake，也会周期性 scheduleNext() 扫描。
 * - scheduleNext() 会按最早 nextRunAt 计算延迟，但受 minDelayMs 与 defaultIntervalMs 双重夹逼，避免 tight loop。
 */

export class VectorDocumentScheduler extends BaseScheduler {
  private offDirtyListener: (() => void) | null = null;

  private minDelayMs = 5000; // 最小 5s 间隔：避免 DB 为空或任务异常时紧循环
  private defaultIntervalMs = processingConfig.scheduler.scanIntervalMs;

  constructor() {
    super();
    this.onDirty = this.onDirty.bind(this);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Vector document scheduler started");

    this.offDirtyListener = onVectorDocumentsDirty(this.onDirty);
    this.scheduleSoon();
  }

  stop(): void {
    this.isRunning = false;
    this.clearTimer();
    if (this.offDirtyListener) {
      this.offDirtyListener();
      this.offDirtyListener = null;
    }
    logger.info("Vector document scheduler stopped");
  }

  private onDirty(event: VectorDocumentDirtyEvent): void {
    this.wake(event.reason);
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
    return this.minDelayMs;
  }

  protected onScheduledNext(delayMs: number, earliestNextRun: number | null): void {
    logger.debug({ delayMs, earliestNextRun }, "Scheduled next vector document cycle");
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

    // embedding：只要 pending/failed 且 attempts 未超限，即视为“未来需要处理”；
    // nextRunAt 为 null 表示“尽快执行”。
    const embedding = db
      .select({ nextRunAt: vectorDocuments.embeddingNextRunAt })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          lt(vectorDocuments.embeddingAttempts, processingConfig.scheduler.retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(vectorDocuments.embeddingNextRunAt))
      .limit(1)
      .get();
    if (embedding) {
      consider(embedding.nextRunAt ?? now);
    }

    // index：前置条件是 embedding succeeded；其余规则同 embedding。
    const index = db
      .select({ nextRunAt: vectorDocuments.indexNextRunAt })
      .from(vectorDocuments)
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          lt(vectorDocuments.indexAttempts, processingConfig.scheduler.retryConfig.maxAttempts)
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

  protected override async runCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;

    this.isProcessing = true;
    logger.debug("Starting vector document scheduler cycle");

    try {
      // 1) 崩溃/超时恢复：running 太久的任务回滚为 pending。
      await this.recoverStaleStates();

      // 2) 扫描 due 的任务（embedding 与 index）。
      const records = await this.scanPendingRecords();
      if (records.length === 0) {
        return;
      }

      // 3) 并发推进：先 embedding，后 index（降低端到端延迟）。
      const embeddingLimit = Math.max(1, Math.min(aiRuntimeService.getLimit("embedding"), 10));
      const indexLimit = 10;

      const embeddingRecords = records.filter((r) => r.subtask === "embedding");
      const indexRecords = records.filter((r) => r.subtask === "index");

      // 同一轮内先做 embedding，再做 index：embedding 成功后虽然本轮不会二次 scan，
      // 但下一轮会很快捞起（wakeRequested + scheduleSoon），整体延迟可控。
      await this.processGroup(embeddingRecords, embeddingLimit, "embedding");
      await this.processGroup(indexRecords, indexLimit, "index");
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Error in vector document scheduler cycle"
      );
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

  private async recoverStaleStates(): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const staleThreshold = now - processingConfig.scheduler.staleRunningThresholdMs;

    const staleVectorEmbeddings = db
      .update(vectorDocuments)
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

    const staleVectorIndexes = db
      .update(vectorDocuments)
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

    const staleDocCount = staleVectorEmbeddings.changes + staleVectorIndexes.changes;
    if (staleDocCount > 0) {
      logger.info({ count: staleDocCount }, "Recovered stale states in vector_documents");
    }
  }

  private async scanPendingRecords(): Promise<PendingRecord[]> {
    const db = getDb();
    const now = Date.now();
    const limit = 100; // 单轮扫描上限：避免一次性拉太多记录导致长事务/卡顿

    const embeddingsPending: PendingRecord[] = [];

    // Embedding 子任务：pending/failed 且 nextRunAt 到期。
    const embeddingTasks = db
      .select({
        id: vectorDocuments.id,
        embeddingStatus: vectorDocuments.embeddingStatus,
        embeddingAttempts: vectorDocuments.embeddingAttempts,
        embeddingNextRunAt: vectorDocuments.embeddingNextRunAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          or(
            isNull(vectorDocuments.embeddingNextRunAt),
            lte(vectorDocuments.embeddingNextRunAt, now)
          ),
          lt(vectorDocuments.embeddingAttempts, processingConfig.scheduler.retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    for (const r of embeddingTasks) {
      embeddingsPending.push({
        id: r.id,
        table: "vector_documents",
        status: r.embeddingStatus as "pending" | "failed",
        attempts: r.embeddingAttempts,
        nextRunAt: r.embeddingNextRunAt ?? undefined,
        subtask: "embedding",
      });
    }

    // Index 子任务：前置条件 embedding succeeded。
    const indexTasks = db
      .select({
        id: vectorDocuments.id,
        indexStatus: vectorDocuments.indexStatus,
        indexAttempts: vectorDocuments.indexAttempts,
        indexNextRunAt: vectorDocuments.indexNextRunAt,
      })
      .from(vectorDocuments)
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          or(isNull(vectorDocuments.indexNextRunAt), lte(vectorDocuments.indexNextRunAt, now)),
          lt(vectorDocuments.indexAttempts, processingConfig.scheduler.retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    for (const r of indexTasks) {
      embeddingsPending.push({
        id: r.id,
        table: "vector_documents",
        status: r.indexStatus as "pending" | "failed",
        attempts: r.indexAttempts,
        nextRunAt: r.indexNextRunAt ?? undefined,
        subtask: "index",
      });
    }

    return embeddingsPending;
  }

  private async processGroup(
    records: PendingRecord[],
    concurrency: number,
    groupName: string
  ): Promise<void> {
    if (records.length === 0) return;

    const workerCount = Math.min(concurrency, records.length);
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex;
        nextIndex++;
        if (current >= records.length) return;

        const record = records[current];
        try {
          if (record.subtask === "index") {
            await this.processVectorDocumentIndexRecord(record);
          } else {
            await this.processVectorDocumentEmbeddingRecord(record);
          }
        } catch (error) {
          logger.error(
            { group: groupName, recordId: record.id, error: String(error) },
            "Failed to process vector document record"
          );
        }
      }
    });

    await Promise.all(workers);
  }

  private async processVectorDocumentEmbeddingRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    try {
      // 认领（claim）：把 pending/failed 原子地改为 running，避免并发重复处理。
      const claim = db
        .update(vectorDocuments)
        .set({ embeddingStatus: "running", updatedAt: Date.now() })
        .where(
          and(
            eq(vectorDocuments.id, record.id),
            or(
              eq(vectorDocuments.embeddingStatus, "pending"),
              eq(vectorDocuments.embeddingStatus, "failed")
            )
          )
        )
        .run();

      if (claim.changes === 0) return;

      const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();
      if (!doc || doc.embeddingStatus === "succeeded") return;

      if (!doc.refId) throw new Error("Vector document missing refId");

      // embedding 输入文本来自 context node 的“规范化文本”。
      const text = await vectorDocumentService.buildTextForNode(doc.refId);
      const vector = await embeddingService.embed(text);
      const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

      db.update(vectorDocuments)
        .set({
          embedding: buffer,
          embeddingStatus: "succeeded",
          embeddingNextRunAt: null,
          errorMessage: null,
          errorCode: null,
          indexStatus: "pending",
          indexAttempts: 0,
          indexNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(vectorDocuments.id, doc.id), eq(vectorDocuments.embeddingStatus, "running")))
        .run();

      logger.debug({ docId: doc.id }, "Generated embedding for vector document");
    } catch (error) {
      const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();
      if (!doc) return;
      const message = error instanceof Error ? error.message : String(error);
      const attempts = doc.embeddingAttempts + 1;
      const isPermanent = attempts >= processingConfig.scheduler.retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);

      db.update(vectorDocuments)
        .set({
          embeddingStatus: isPermanent ? "failed_permanent" : "failed",
          embeddingAttempts: attempts,
          embeddingNextRunAt: nextRun,
          errorMessage: message,
          updatedAt: Date.now(),
        })
        .where(and(eq(vectorDocuments.id, doc.id), eq(vectorDocuments.embeddingStatus, "running")))
        .run();
    }
  }

  private async processVectorDocumentIndexRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    try {
      // 认领（claim）：把 pending/failed 原子地改为 running。
      const claim = db
        .update(vectorDocuments)
        .set({ indexStatus: "running", updatedAt: Date.now() })
        .where(
          and(
            eq(vectorDocuments.id, record.id),
            eq(vectorDocuments.embeddingStatus, "succeeded"),
            or(
              eq(vectorDocuments.indexStatus, "pending"),
              eq(vectorDocuments.indexStatus, "failed")
            )
          )
        )
        .run();

      if (claim.changes === 0) return;

      const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();
      if (!doc || doc.embeddingStatus !== "succeeded" || !doc.embedding) return;

      // DB 中 embedding 以 Buffer 存储，读取后映射回 Float32Array。
      const buffer = doc.embedding as Buffer;
      const vector = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

      await vectorIndexService.upsert(doc.id, vector);
      vectorIndexService.requestFlush();

      db.update(vectorDocuments)
        .set({
          indexStatus: "succeeded",
          indexNextRunAt: null,
          errorMessage: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(vectorDocuments.id, doc.id), eq(vectorDocuments.indexStatus, "running")))
        .run();

      logger.debug({ docId: doc.id }, "Indexed vector document");
    } catch (error) {
      const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();
      if (!doc) return;
      const message = error instanceof Error ? error.message : String(error);
      const attempts = doc.indexAttempts + 1;
      const isPermanent = attempts >= processingConfig.scheduler.retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);

      db.update(vectorDocuments)
        .set({
          indexStatus: isPermanent ? "failed_permanent" : "failed",
          indexAttempts: attempts,
          indexNextRunAt: nextRun,
          errorMessage: message,
          updatedAt: Date.now(),
        })
        .where(and(eq(vectorDocuments.id, doc.id), eq(vectorDocuments.indexStatus, "running")))
        .run();
    }
  }

  private calculateNextRun(attempts: number): number {
    const { backoffScheduleMs, jitterMs } = processingConfig.scheduler.retryConfig;
    const baseDelay = backoffScheduleMs[Math.min(attempts - 1, backoffScheduleMs.length - 1)];
    const jitter = Math.random() * jitterMs;
    return Date.now() + baseDelay + jitter;
  }
}

export const vectorDocumentScheduler = new VectorDocumentScheduler();
