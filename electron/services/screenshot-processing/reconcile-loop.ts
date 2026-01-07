import { eq, and, or, lt, isNull, lte, desc, ne, inArray, asc, isNotNull } from "drizzle-orm";
import { getDb } from "../../database";
import { batches, contextNodes, screenshots, vectorDocuments } from "../../database/schema";
import { getLogger } from "../logger";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "../screen-capture/types";
import { batchConfig, evidenceConfig, reconcileConfig, retryConfig } from "./config";
import { aiRuntimeService } from "../ai-runtime-service";
import { batchBuilder } from "./batch-builder";
import { contextGraphService } from "./context-graph-service";
import { vectorDocumentService } from "./vector-document-service";
import { entityService } from "./entity-service";
import { expandVLMIndexToNodes, textLLMProcessor } from "./text-llm-processor";

import { runVlmOnBatch } from "./vlm-processor";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";

import type { VLMIndexResult } from "./schemas";
import type {
  AcceptedScreenshot,
  Batch,
  DetectedEntity,
  ExpandedContextNode,
  HistoryPack,
  PendingRecord,
  Shard,
  SourceKey,
} from "./types";
import type { ContextNodeRecord } from "../../database/schema";

const logger = getLogger("reconcile-loop");
const IDLE_SCAN_INTERVAL_MS = reconcileConfig.scanIntervalMs;

function getCanonicalAppCandidates(): string[] {
  return Object.keys(DEFAULT_WINDOW_FILTER_CONFIG.appAliases);
}

/**
 * `ReconcileLoop` 是截图处理管线的后台“对账/修复”调度器。
 *
 * 核心目标：
 * - 把数据库里标记为 `pending` / `failed` 的工作推进到最终一致（`succeeded` 或 `failed_permanent`）。
 * - 通过 `status/attempts/nextRunAt/updatedAt` 等字段实现“可恢复的任务队列”：
 *   - **认领**：用 `UPDATE ... WHERE status IN (...)` 原子方式把任务置为 `running`。
 *   - **重试/退避**：失败后写入 `nextRunAt`，并按指数退避 + 随机抖动再次调度。
 *   - **崩溃恢复**：若 `running` 持续超过阈值，则回滚为 `pending` 重新跑。
 *
 * 本文件管理的任务类型（同一轮 `run()` 内按类型并发推进）：
 * - **batches**：批量运行 VLM（视觉模型）+ 落库截图证据；随后触发后续节点/向量文档的同步。
 * - **context_nodes.merge**：同线程/同 kind 的节点合并（文本语言模型）。
 * - **vector_documents.embedding**：为节点生成向量表示（embedding）并落库。
 * - **vector_documents.index**：把向量表示（embedding）写入本地向量索引（HNSW），并请求刷新/落盘。
 *
 * 调度方式：
 * - `wake()`：外部触发“立刻跑一轮”，内部用“去抖”避免重复排队。
 * - `schedule()`：空闲时按 `computeNextRunAt()`（或固定间隔）设置 `setTimeout`。
 */
export class ReconcileLoop {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private wakeScheduled = false;
  private wakeRequested = false;

  // `timer`：下一轮调度的 `setTimeout` 句柄
  // `isRunning`：循环是否已 `start()` 且未 `stop()`
  // `isProcessing`：当前是否正在执行一轮 `run()`（用于防止重入）
  // `wakeScheduled`：是否已经排队了一个 `setImmediate(() => run())`
  // `wakeRequested`：当 `isProcessing=true` 时收到 `wake()`，置为 true；本轮结束后立刻再跑一轮

  private clampInt(value: number, min: number, max: number): number {
    const v = Math.floor(value);
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  /**
   * 每轮扫描数据库时的“拉取上限”。
   *
   * 设计目的：
   * - 拉得太少会导致并发执行单元空转、需要频繁重复扫描。
   * - 拉得太多会导致一次扫描读出大量无用行、加剧锁竞争。
   *
   * 这里用当前各类并发执行单元的并发上限推导一个合理的扫描上限，并再做范围限制。
   */
  private getScanLimit(): number {
    const batchWorkers = this.getBatchWorkerLimit();
    const mergeWorkers = this.getMergeWorkerLimit();
    const embeddingWorkers = this.getEmbeddingWorkerLimit();
    const indexWorkers = this.getIndexWorkerLimit();

    // 取并发执行单元数的若干倍：在任务被“认领走”的期间减少重复扫描。
    const derived = (batchWorkers + mergeWorkers + embeddingWorkers + indexWorkers) * 4;
    return this.clampInt(derived, 20, 200);
  }

  private getBatchWorkerLimit(): number {
    // 批处理任务的核心瓶颈是 VLM 的并发许可。
    // 这里故意把批处理任务的并发执行单元控制得更小，避免创建过多“调度任务”却都卡在同一个 VLM 信号量上。
    const vlmLimit = aiRuntimeService.getLimit("vlm");
    return this.clampInt(Math.ceil(vlmLimit / 2), 1, 4);
  }

  private getMergeWorkerLimit(): number {
    const textLimit = aiRuntimeService.getLimit("text");
    return this.clampInt(textLimit, 1, 10);
  }

  private getEmbeddingWorkerLimit(): number {
    const embeddingLimit = aiRuntimeService.getLimit("embedding");
    return this.clampInt(embeddingLimit, 1, 10);
  }

  private getIndexWorkerLimit(): number {
    // 向量索引写入/更新主要受本地 CPU/IO 影响；这里给一个固定上限即可。
    return 10;
  }

  /**
   * 启动调度循环。
   *
   * 启动后不会“常驻忙等”，而是：
   * - 先 `wake()` 立即跑一轮；
   * - 每轮结束后根据 `computeNextRunAt()` 计算下一次 `setTimeout`。
   */
  start(): void {
    if (!reconcileConfig.enabled) {
      logger.info("Reconcile loop disabled by config");
      return;
    }
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("Reconcile loop started");

    this.wake();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.isRunning) {
      return;
    }

    this.clearTimer();

    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : IDLE_SCAN_INTERVAL_MS;
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
  }

  private computeNextRunAt(now: number): number | null {
    const db = getDb();
    let next: number | null = null;

    const consider = (candidate: number | null | undefined): void => {
      if (candidate == null) return;
      if (next == null || candidate < next) {
        next = candidate;
      }
    };

    const batch = db
      .select({ nextRunAt: batches.nextRunAt })
      .from(batches)
      .where(
        and(
          or(eq(batches.status, "pending"), eq(batches.status, "failed")),
          lt(batches.attempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(batches.nextRunAt))
      .limit(1)
      .get();
    if (batch) {
      consider(batch.nextRunAt ?? now);
    }

    const merge = db
      .select({ nextRunAt: contextNodes.mergeNextRunAt })
      .from(contextNodes)
      .where(
        and(
          or(eq(contextNodes.mergeStatus, "pending"), eq(contextNodes.mergeStatus, "failed")),
          lt(contextNodes.mergeAttempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(contextNodes.mergeNextRunAt))
      .limit(1)
      .get();
    if (merge) {
      consider(merge.nextRunAt ?? now);
    }

    const embedding = db
      .select({ nextRunAt: vectorDocuments.embeddingNextRunAt })
      .from(vectorDocuments)
      .where(
        and(
          or(
            eq(vectorDocuments.embeddingStatus, "pending"),
            eq(vectorDocuments.embeddingStatus, "failed")
          ),
          lt(vectorDocuments.embeddingAttempts, retryConfig.maxAttempts)
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
          lt(vectorDocuments.indexAttempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(asc(vectorDocuments.indexNextRunAt))
      .limit(1)
      .get();
    if (index) {
      consider(index.nextRunAt ?? now);
    }

    const orphan = db
      .select({ createdAt: screenshots.createdAt })
      .from(screenshots)
      .where(
        and(
          isNull(screenshots.enqueuedBatchId),
          or(eq(screenshots.vlmStatus, "pending"), eq(screenshots.vlmStatus, "failed")),
          lt(screenshots.vlmAttempts, retryConfig.maxAttempts),
          isNotNull(screenshots.filePath),
          ne(screenshots.storageState, "deleted")
        )
      )
      .orderBy(asc(screenshots.createdAt))
      .limit(1)
      .get();
    if (orphan) {
      const minAgeMs = batchConfig.batchTimeoutMs + 5000;
      const eligibleAt = orphan.createdAt + minAgeMs;
      consider(eligibleAt <= now ? now : eligibleAt);
    }

    if (next == null) {
      return null;
    }

    return Math.max(next, now);
  }

  private async enqueueOrphanScreenshots(): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const minAgeMs = batchConfig.batchTimeoutMs + 5000;
    const cutoffCreatedAt = now - minAgeMs;

    const limit = this.getScanLimit();

    const existingBatchRows = db
      .select({ id: batches.id, screenshotIds: batches.screenshotIds })
      .from(batches)
      .where(
        and(
          or(
            eq(batches.status, "pending"),
            eq(batches.status, "failed"),
            eq(batches.status, "running")
          ),
          lt(batches.attempts, retryConfig.maxAttempts)
        )
      )
      .orderBy(desc(batches.updatedAt))
      .limit(limit)
      .all();

    for (const row of existingBatchRows) {
      try {
        const ids = JSON.parse(row.screenshotIds) as number[];
        if (ids.length === 0) continue;
        db.update(screenshots)
          .set({ enqueuedBatchId: row.id, updatedAt: now })
          .where(and(inArray(screenshots.id, ids), isNull(screenshots.enqueuedBatchId)))
          .run();
      } catch {
        continue;
      }
    }

    const candidates = db
      .select({
        id: screenshots.id,
        ts: screenshots.ts,
        sourceKey: screenshots.sourceKey,
        phash: screenshots.phash,
        filePath: screenshots.filePath,
        width: screenshots.width,
        height: screenshots.height,
        bytes: screenshots.bytes,
        mime: screenshots.mime,
        appHint: screenshots.appHint,
        windowTitle: screenshots.windowTitle,
      })
      .from(screenshots)
      .where(
        and(
          isNull(screenshots.enqueuedBatchId),
          or(eq(screenshots.vlmStatus, "pending"), eq(screenshots.vlmStatus, "failed")),
          lt(screenshots.vlmAttempts, retryConfig.maxAttempts),
          lte(screenshots.createdAt, cutoffCreatedAt),
          isNotNull(screenshots.filePath),
          ne(screenshots.storageState, "deleted")
        )
      )
      .orderBy(asc(screenshots.sourceKey), asc(screenshots.ts))
      .limit(limit)
      .all();

    if (candidates.length === 0) {
      return;
    }

    const bySource = new Map<SourceKey, typeof candidates>();
    for (const row of candidates) {
      const key = row.sourceKey as SourceKey;
      const arr = bySource.get(key);
      if (arr) {
        arr.push(row);
      } else {
        bySource.set(key, [row]);
      }
    }

    let createdBatches = 0;
    for (const [sourceKey, rows] of bySource) {
      for (let i = 0; i < rows.length; i += batchConfig.batchSize) {
        const chunk = rows.slice(i, i + batchConfig.batchSize);
        const accepted: AcceptedScreenshot[] = chunk.map((s) => ({
          id: s.id,
          ts: s.ts,
          sourceKey,
          phash: s.phash ?? "",
          filePath: s.filePath!,
          meta: {
            appHint: s.appHint ?? undefined,
            windowTitle: s.windowTitle ?? undefined,
            width: s.width ?? undefined,
            height: s.height ?? undefined,
            bytes: s.bytes ?? undefined,
            mime: s.mime ?? undefined,
          },
        }));

        try {
          const { batch } = await batchBuilder.createAndPersistBatch(sourceKey, accepted);
          createdBatches++;
          logger.info(
            { batchId: batch.batchId, sourceKey, screenshotCount: accepted.length },
            "Enqueued orphan screenshots into batch"
          );
        } catch (error) {
          logger.warn(
            { sourceKey, error: error instanceof Error ? error.message : String(error) },
            "Failed to enqueue orphan screenshots into batch"
          );
        }
      }
    }

    if (createdBatches > 0) {
      this.wakeRequested = true;
    }
  }

  /**
   * 停止调度循环。
   *
   * 注意：如果此前已经排队了 `setImmediate(run)`，`run()` 开头会再次检查 `isRunning` 并直接退出。
   */
  stop(): void {
    this.isRunning = false;
    this.wakeScheduled = false;
    this.wakeRequested = false;
    this.clearTimer();
    logger.info("Reconcile loop stopped");
  }

  /**
   * 请求“立刻跑一轮”。
   *
   * 这里使用“去抖”：
   * - 同一时刻只允许排队一个 `setImmediate(run)`（由 `wakeScheduled` 控制）。
   * - 如果当前正在 `run()` 中（`isProcessing=true`），则只设置 `wakeRequested=true`，
   *   等本轮 `finally` 里再次 `wake()`。
   */
  wake(): void {
    if (!this.isRunning) return;

    this.clearTimer();

    // 如果正在执行一轮 run()，则记一个“需要再跑一轮”的标记，避免重入。
    if (this.isProcessing) {
      this.wakeRequested = true;
      return;
    }

    // 已经排队了一个 setImmediate，则不重复排队。
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      void this.run();
    });
  }

  /**
   * 主执行周期（一次“调度轮次”）。
   *
   * 一轮的结构固定为：
   * 1) `recoverStaleStates()`：把长时间 `running` 的任务回滚到 `pending`，保证可恢复。
   * 2) `scanPendingRecords()`：扫描可执行的 pending/failed 任务（考虑 `nextRunAt`）。
   * 3) 并发推进：
   *    - 批处理任务（VLM）与其他任务（合并/向量生成/索引）并行执行，避免互相阻塞。
   * 4) `enqueueOrphanScreenshots()`：把“遗漏入批”的截图补入批处理，保证最终不掉队。
   * 5) 结束时决定下一次调度：若 `wakeRequested=true` 则立刻再跑，否则按 `computeNextRunAt()` 休眠。
   */
  private async run(): Promise<void> {
    // 防止 stop() 后仍有排队的 setImmediate 进来。
    if (!this.isRunning) {
      this.wakeScheduled = false;
      this.wakeRequested = false;
      return;
    }
    if (this.isProcessing) return;
    this.isProcessing = true;
    // 本轮开始时清掉 wakeScheduled 标记：表示“已排队的立即执行请求”已被本轮消费。
    this.wakeScheduled = false;

    try {
      // 1) 崩溃/卡死恢复：把长时间处于 `running` 的任务回滚成 `pending`
      await this.recoverStaleStates();

      const records = await this.scanPendingRecords();

      // 批处理（VLM）与其他任务分开：VLM 可能慢，不能让向量生成/索引等被“饿死”。
      const batchRecords = records.filter((r) => r.table === "batches");
      const otherRecords = records.filter((r) => r.table !== "batches");

      // 两条流水线并行：
      // - batchPromise：批处理（含 VLM + 落库）
      // - otherPromise：节点合并/向量生成/索引 等不依赖 VLM 并发许可的任务
      const batchPromise =
        batchRecords.length > 0 ? this.processBatchesConcurrently(batchRecords) : Promise.resolve();

      // otherRecords 内部按类型（合并 / 向量生成 / 索引）继续并行。
      const otherPromise = this.processOtherRecordsConcurrently(otherRecords);

      // 等两条流水线都结束，再做补扫。
      await Promise.all([batchPromise, otherPromise]);

      await this.enqueueOrphanScreenshots();
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Error in reconcile loop cycle"
      );
    } finally {
      this.isProcessing = false;

      if (!this.isRunning) {
        this.wakeScheduled = false;
        this.wakeRequested = false;
        this.clearTimer();
      } else if (this.wakeRequested) {
        this.wakeRequested = false;
        this.wake();
      } else {
        const now = Date.now();
        try {
          const nextRunAt = this.computeNextRunAt(now);
          let delayMs = IDLE_SCAN_INTERVAL_MS;
          if (nextRunAt != null) {
            delayMs = Math.max(0, nextRunAt - now);
            if (delayMs > IDLE_SCAN_INTERVAL_MS) {
              delayMs = IDLE_SCAN_INTERVAL_MS;
            }
          }

          this.schedule(delayMs);
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "Failed to compute next run time; falling back to idle schedule"
          );
          this.schedule(IDLE_SCAN_INTERVAL_MS);
        }
      }
    }
  }

  /**
   * 并发处理批处理任务（有并发上限）。
   *
   * 设计点：
   * - 并发上限来自 `getBatchWorkerLimit()`（与 VLM 并发许可相关）。
   * - 使用 `Promise.allSettled()`：单个批处理失败不会阻塞同一轮里其他批处理的推进。
   * - 外层按“分块”分批执行：避免一次性把所有批处理都扔进 promise 池造成瞬时峰值。
   */
  private async processBatchesConcurrently(records: PendingRecord[]): Promise<void> {
    const concurrency = this.getBatchWorkerLimit();

    logger.info(
      { totalBatches: records.length, concurrency },
      "Starting concurrent batch processing"
    );

    // 按并发上限分块处理：每个 `chunk` 内并行，`chunk` 与 `chunk` 之间串行。
    for (let i = 0; i < records.length; i += concurrency) {
      const chunk = records.slice(i, i + concurrency);
      const chunkIndex = Math.floor(i / concurrency) + 1;
      const totalChunks = Math.ceil(records.length / concurrency);

      logger.debug({ chunkIndex, totalChunks, chunkSize: chunk.length }, "Processing batch chunk");

      const results = await Promise.allSettled(
        chunk.map((record) => this.processBatchRecord(record))
      );

      // 汇总本分块的执行结果（不影响后续分块）。
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      if (failed > 0) {
        logger.warn({ chunkIndex, succeeded, failed }, "Some batches in chunk failed");
      }
    }
  }

  /**
   * 并发处理非批处理类任务。
   *
   * 做法：先按任务类型分组，再让每个组以自己的并发上限独立推进。
   * 这样可以避免某一类任务“挤占”另一类任务的执行机会。
   */
  private async processOtherRecordsConcurrently(records: PendingRecord[]): Promise<void> {
    if (records.length === 0) return;

    // 按任务类型分组。
    const mergeRecords = records.filter((r) => r.table === "context_nodes");
    const embeddingRecords = records.filter(
      (r) => r.table === "vector_documents" && r.subtask === "embedding"
    );
    const indexRecords = records.filter(
      (r) => r.table === "vector_documents" && r.subtask === "index"
    );
    logger.debug(
      {
        mergeCount: mergeRecords.length,
        embeddingCount: embeddingRecords.length,
        indexCount: indexRecords.length,
      },
      "Processing other records concurrently"
    );

    // 三类任务并行推进；内部各自有并发控制。
    await Promise.allSettled([
      this.processRecordsWithConcurrency(mergeRecords, this.getMergeWorkerLimit(), "merge"),
      this.processRecordsWithConcurrency(
        embeddingRecords,
        this.getEmbeddingWorkerLimit(),
        "embedding"
      ),
      this.processRecordsWithConcurrency(indexRecords, this.getIndexWorkerLimit(), "index"),
    ]);
  }

  /**
   * 以“固定并发执行单元数 + 共享游标”的方式推进同一组任务。
   *
   * 这里不是严格意义的队列：
   * - 每个并发执行单元从 `records[nextIndex]` 取一个任务执行；
   * - 单个任务真正的互斥/去重依赖数据库的“认领”（UPDATE ... WHERE status...）。
   */
  private async processRecordsWithConcurrency(
    records: PendingRecord[],
    concurrency: number,
    groupName: string
  ): Promise<void> {
    if (records.length === 0) return;

    const workerCount = Math.max(1, Math.min(concurrency, records.length));
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex;
        nextIndex++;
        if (current >= records.length) return;

        const record = records[current];
        try {
          await this.processRecord(record);
        } catch (error) {
          logger.error(
            { group: groupName, recordId: record.id, error: String(error) },
            "Failed to process record in group"
          );
        }
      }
    });

    await Promise.all(workers);
  }

  /**
   * 崩溃/卡死恢复：
   * 把超过 `staleRunningThresholdMs` 的 `running` 任务回滚到 `pending`，并清理 nextRunAt。
   *
   * 原因：进程崩溃或异常退出时，数据库里可能残留 `running`；不回滚就会导致任务永久卡住。
   */
  private async recoverStaleStates(): Promise<void> {
    const db = getDb();
    const staleThreshold = Date.now() - reconcileConfig.staleRunningThresholdMs;

    const staleScreenshots = db
      .update(screenshots)
      .set({
        vlmStatus: "pending",
        vlmNextRunAt: null,
        updatedAt: Date.now(),
      })
      .where(and(eq(screenshots.vlmStatus, "running"), lt(screenshots.updatedAt, staleThreshold)))
      .run();

    if (staleScreenshots.changes > 0) {
      logger.info({ count: staleScreenshots.changes }, "Recovered stale VLM states in screenshots");
    }

    const staleBatches = db
      .update(batches)
      .set({
        status: "pending",
        nextRunAt: null,
        updatedAt: Date.now(),
      })
      .where(and(eq(batches.status, "running"), lt(batches.updatedAt, staleThreshold)))
      .run();

    if (staleBatches.changes > 0) {
      logger.info({ count: staleBatches.changes }, "Recovered stale states in batches");
    }

    // 恢复 context_nodes.mergeStatus
    const staleNodes = db
      .update(contextNodes)
      .set({
        mergeStatus: "pending",
        updatedAt: Date.now(),
      })
      .where(
        and(eq(contextNodes.mergeStatus, "running"), lt(contextNodes.updatedAt, staleThreshold))
      )
      .run();

    if (staleNodes.changes > 0) {
      logger.info({ count: staleNodes.changes }, "Recovered stale merge states in context_nodes");
    }

    // 恢复 context_nodes.embeddingStatus
    const staleEmbeddingNodes = db
      .update(contextNodes)
      .set({
        embeddingStatus: "pending",
        updatedAt: Date.now(),
      })
      .where(
        and(eq(contextNodes.embeddingStatus, "running"), lt(contextNodes.updatedAt, staleThreshold))
      )
      .run();

    if (staleEmbeddingNodes.changes > 0) {
      logger.info(
        { count: staleEmbeddingNodes.changes },
        "Recovered stale embedding states in context_nodes"
      );
    }

    // 恢复 vector_documents 的 embedding/index 子任务
    const now = Date.now();

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
    const limit = this.getScanLimit();

    // 说明：这里不再直接扫描 screenshots。
    // 所有截图都应该经由 batches 进入 VLM 流水线，避免“截图级 VLM”与“批级 VLM”之间的竞态。

    const batchRows = db
      .select({
        id: batches.id,
        status: batches.status,
        attempts: batches.attempts,
        nextRunAt: batches.nextRunAt,
      })
      .from(batches)
      .where(
        and(
          or(eq(batches.status, "pending"), eq(batches.status, "failed")),
          or(isNull(batches.nextRunAt), lte(batches.nextRunAt, now)),
          lt(batches.attempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    const mergeRows = db
      .select({
        id: contextNodes.id,
        status: contextNodes.mergeStatus,
        attempts: contextNodes.mergeAttempts,
        nextRunAt: contextNodes.mergeNextRunAt,
      })
      .from(contextNodes)
      .where(
        and(
          or(eq(contextNodes.mergeStatus, "pending"), eq(contextNodes.mergeStatus, "failed")),
          or(isNull(contextNodes.mergeNextRunAt), lte(contextNodes.mergeNextRunAt, now)),
          lt(contextNodes.mergeAttempts, retryConfig.maxAttempts)
        )
      )
      .limit(limit)
      .all();

    // vector_documents 的 `embedding`/`index` 是两个独立子任务，因此分别扫描并在 PendingRecord 上标注子任务字段（`subtask`）。

    const batchesPending: PendingRecord[] = batchRows.map((r) => ({
      id: r.id,
      table: "batches",
      status: r.status as "pending" | "failed",
      attempts: r.attempts,
      nextRunAt: r.nextRunAt ?? undefined,
    }));

    const mergesPending: PendingRecord[] = mergeRows.map((r) => ({
      id: r.id,
      table: "context_nodes",
      status: r.status as "pending" | "failed",
      attempts: r.attempts,
      nextRunAt: r.nextRunAt ?? undefined,
    }));

    const embeddingsPending: PendingRecord[] = [];

    // 子任务 1：向量生成（embeddingStatus in 'pending' | 'failed'）
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
          lt(vectorDocuments.embeddingAttempts, retryConfig.maxAttempts)
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

    // 子任务 2：向量索引（indexStatus in 'pending' | 'failed' 且 embeddingStatus='succeeded'）
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
          // 前置条件：必须先完成 embedding 才允许进入 indexing。
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          or(eq(vectorDocuments.indexStatus, "pending"), eq(vectorDocuments.indexStatus, "failed")),
          or(isNull(vectorDocuments.indexNextRunAt), lte(vectorDocuments.indexNextRunAt, now)),
          lt(vectorDocuments.indexAttempts, retryConfig.maxAttempts)
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

    return [...batchesPending, ...mergesPending, ...embeddingsPending];
  }

  private async processRecord(record: PendingRecord): Promise<void> {
    switch (record.table) {
      case "batches":
        await this.processBatchRecord(record);
        return;
      case "context_nodes":
        await this.processContextNodeMergeRecord(record);
        return;
      case "vector_documents":
        if (record.subtask === "index") {
          await this.processVectorDocumentIndexRecord(record);
        } else {
          // 未指定子任务字段（`subtask`）时默认当作 `embedding`。
          await this.processVectorDocumentEmbeddingRecord(record);
        }
        return;
    }
  }

  private async processBatchRecord(record: PendingRecord): Promise<void> {
    const processStartTime = Date.now();
    const db = getDb();

    const batchRecord = db.select().from(batches).where(eq(batches.id, record.id)).get();

    if (!batchRecord) {
      return;
    }

    if (batchRecord.status !== "pending" && batchRecord.status !== "failed") {
      return;
    }

    if (batchRecord.attempts >= retryConfig.maxAttempts) {
      return;
    }

    let screenshotIds: number[] = [];
    try {
      screenshotIds = JSON.parse(batchRecord.screenshotIds) as number[];
    } catch {
      screenshotIds = [];
    }

    // 仅用于日志的耗时统计（不参与调度决策）。
    let vlmMs = 0;
    let textLlmMs = 0;

    try {
      const now = Date.now();

      logger.info(
        { batchId: batchRecord.batchId, screenshotCount: screenshotIds.length },
        "Starting batch processing"
      );

      const claim = db
        .update(batches)
        .set({
          status: "running",
          errorMessage: null,
          errorCode: null,
          updatedAt: now,
          attempts: batchRecord.attempts + 1,
        })
        .where(
          and(
            eq(batches.id, batchRecord.id),
            or(eq(batches.status, "pending"), eq(batches.status, "failed"))
          )
        )
        .run();

      if (claim.changes === 0) {
        // claim 失败：说明被别的并发执行单元先认领了（并发竞争下的正常情况）。
        return;
      }

      if (screenshotIds.length > 0) {
        db.update(screenshots)
          .set({ vlmStatus: "running", enqueuedBatchId: batchRecord.id, updatedAt: now })
          .where(
            and(
              inArray(screenshots.id, screenshotIds),
              or(
                isNull(screenshots.enqueuedBatchId),
                eq(screenshots.enqueuedBatchId, batchRecord.id)
              )
            )
          )
          .run();
      }

      const shotRows = screenshotIds.length
        ? db.select().from(screenshots).where(inArray(screenshots.id, screenshotIds)).all()
        : [];

      const missing = shotRows.find((s) => !s.filePath);
      if (missing) {
        throw new Error(`Missing filePath for screenshot ${missing.id}`);
      }

      const sourceKey = batchRecord.sourceKey as SourceKey;
      const accepted: AcceptedScreenshot[] = shotRows.map((s) => ({
        id: s.id,
        ts: s.ts,
        sourceKey,
        phash: s.phash ?? "",
        filePath: s.filePath!,
        meta: {
          appHint: s.appHint ?? undefined,
          windowTitle: s.windowTitle ?? undefined,
          width: s.width ?? undefined,
          height: s.height ?? undefined,
          bytes: s.bytes ?? undefined,
          mime: s.mime ?? undefined,
        },
      }));

      let historyPack: HistoryPack | undefined;
      if (batchRecord.historyPack) {
        try {
          historyPack = JSON.parse(batchRecord.historyPack) as unknown as HistoryPack;
        } catch {
          historyPack = undefined;
        }
      }

      const batch: Batch = {
        batchId: batchRecord.batchId,
        sourceKey,
        screenshots: accepted,
        status: batchRecord.status,
        idempotencyKey: batchRecord.idempotencyKey,
        tsStart: batchRecord.tsStart,
        tsEnd: batchRecord.tsEnd,
        historyPack: historyPack ?? batchBuilder.buildHistoryPack(sourceKey),
      };

      const shards: Shard[] = batchBuilder.splitIntoShards(batch);

      // VLM 阶段：视觉模型对批次/分片做结构化理解。
      const vlmStartTime = Date.now();
      const index = await runVlmOnBatch(batch, shards);
      vlmMs = Date.now() - vlmStartTime;

      logger.debug({ batchId: batchRecord.batchId, vlmMs }, "VLM processing completed");

      // 文本阶段：把 VLM 结果扩展成节点/证据等，并做必要的落库。
      const textLlmStartTime = Date.now();
      await this.persistVlmEvidenceAndFinalize(index, batch);
      textLlmMs = Date.now() - textLlmStartTime;

      logger.debug({ batchId: batchRecord.batchId, textLlmMs }, "Text LLM expansion completed");

      db.update(batches)
        .set({
          status: "succeeded",
          indexJson: JSON.stringify(index),
          errorMessage: null,
          errorCode: null,
          nextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(eq(batches.id, batchRecord.id))
        .run();

      const totalMs = Date.now() - processStartTime;
      logger.info(
        { batchId: batchRecord.batchId, totalMs, vlmMs, textLlmMs },
        "Batch processing completed successfully"
      );
    } catch (error) {
      const totalMs = Date.now() - processStartTime;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { batchId: batchRecord.batchId, totalMs, vlmMs, textLlmMs, error: message },
        "Batch processing failed"
      );
      const attempts = batchRecord.attempts + 1;
      const isPermanent = attempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);
      const updatedAt = Date.now();

      db.update(batches)
        .set({
          status: isPermanent ? "failed_permanent" : "failed",
          attempts,
          nextRunAt: nextRun,
          errorMessage: message,
          updatedAt,
        })
        .where(eq(batches.id, batchRecord.id))
        .run();

      if (screenshotIds.length > 0) {
        const shotRows = db
          .select()
          .from(screenshots)
          .where(inArray(screenshots.id, screenshotIds))
          .all();
        for (const s of shotRows) {
          const nextAttempts = s.vlmAttempts + 1;
          const shotPermanent = nextAttempts >= retryConfig.maxAttempts;
          const shotNextRun = shotPermanent ? null : this.calculateNextRun(nextAttempts);
          db.update(screenshots)
            .set({
              vlmStatus: shotPermanent ? "failed_permanent" : "failed",
              vlmAttempts: nextAttempts,
              vlmNextRunAt: shotNextRun,
              vlmErrorMessage: message,
              updatedAt,
            })
            .where(eq(screenshots.id, s.id))
            .run();
        }
      }
    }
  }

  private async persistVlmEvidenceAndFinalize(index: VLMIndexResult, batch: Batch): Promise<void> {
    const db = getDb();
    const screenshotIds = batch.screenshots.map((s) => s.id);

    const currentAppHintById = new Map<number, string | null>();
    if (screenshotIds.length > 0) {
      const rows = db
        .select({ id: screenshots.id, appHint: screenshots.appHint })
        .from(screenshots)
        .where(inArray(screenshots.id, screenshotIds))
        .all();
      for (const r of rows) {
        currentAppHintById.set(r.id, r.appHint ?? null);
      }
    }

    // VLM 证据的短期保留时间：用于下游流程读取（例如 UI 展示/调试）。
    const retentionTtlMs = 1 * 60 * 60 * 1000;
    const retentionExpiresAt = Date.now() + retentionTtlMs;
    const updatedAt = Date.now();

    const shots = index.screenshots ?? [];
    const shotsById = new Map(shots.map((s) => [s.screenshot_id, s] as const));
    const detectedEntities: DetectedEntity[] = (index.entities ?? []).map((name: string) => ({
      name,
      entityType: "other",
      confidence: 0.7,
      source: "vlm",
    }));
    const detectedEntitiesJson = JSON.stringify(detectedEntities);

    const canonicalApps = getCanonicalAppCandidates();
    const canonicalByLower = new Map(
      canonicalApps.map((name) => [name.toLowerCase(), name] as const)
    );

    for (const screenshotId of screenshotIds) {
      const shot = shotsById.get(screenshotId);
      const existingAppHint = currentAppHintById.get(screenshotId) ?? null;
      const setValues: Partial<typeof screenshots.$inferInsert> = {
        vlmStatus: "succeeded",
        vlmNextRunAt: null,
        vlmErrorMessage: null,
        vlmErrorCode: null,
        retentionExpiresAt,
        detectedEntities: detectedEntitiesJson,
        ocrText: null,
        uiTextSnippets: null,
        updatedAt,
      };

      if (existingAppHint == null) {
        // 仅在用户侧没有显式 appHint 时，才根据 VLM 的 app_guess 做一次“保守填充”。
        const guess = shot?.app_guess;
        const confidence = typeof guess?.confidence === "number" ? guess.confidence : null;
        const rawName = typeof guess?.name === "string" ? guess.name.trim() : "";
        const lower = rawName.toLowerCase();
        const canonical = canonicalByLower.get(lower) ?? null;
        if (
          confidence != null &&
          confidence >= 0.7 &&
          canonical != null &&
          lower !== "unknown" &&
          lower !== "other"
        ) {
          setValues.appHint = canonical;
        }
      }

      if (shot?.ocr_text != null) {
        setValues.ocrText = String(shot.ocr_text).slice(0, evidenceConfig.maxOcrTextLength);
      }

      if (shot?.ui_text_snippets != null) {
        const uiSnippets = (shot.ui_text_snippets as string[])
          .slice(0, evidenceConfig.maxUiTextSnippets)
          .map((s) => String(s).slice(0, 200));
        setValues.uiTextSnippets = JSON.stringify(uiSnippets);
      }

      db.update(screenshots).set(setValues).where(eq(screenshots.id, screenshotId)).run();
    }

    try {
      const expandResult = await expandVLMIndexToNodes(index, batch);

      // 将本次批处理解析出的新节点同步到 vector_documents（后续会由 embedding/index 子任务推进）。
      if (expandResult.success && expandResult.nodeIds.length > 0) {
        let upsertCount = 0;
        for (const nodeIdStr of expandResult.nodeIds) {
          try {
            const nodeId = parseInt(nodeIdStr, 10);
            if (!isNaN(nodeId)) {
              await vectorDocumentService.upsertForContextNode(nodeId);
              upsertCount++;
            }
          } catch (err) {
            logger.warn(
              { nodeIdStr, error: String(err) },
              "Failed to upsert vector doc for new node"
            );
          }
        }
        logger.info({ upsertCount }, "Upserted vector documents for new nodes");
      }
    } catch (error) {
      logger.warn(
        { batchId: batch.batchId, error: error instanceof Error ? error.message : String(error) },
        "Text LLM expansion failed; continuing without blocking VLM pipeline"
      );
    }
  }

  private async processContextNodeMergeRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const node = db.select().from(contextNodes).where(eq(contextNodes.id, record.id)).get() as
      | ContextNodeRecord
      | undefined;

    if (!node) {
      return;
    }

    const claimedAttempts = node.mergeAttempts + 1;

    try {
      const claim = db
        .update(contextNodes)
        .set({ mergeStatus: "running", mergeAttempts: claimedAttempts, updatedAt: Date.now() })
        .where(
          and(
            eq(contextNodes.id, node.id),
            or(eq(contextNodes.mergeStatus, "pending"), eq(contextNodes.mergeStatus, "failed"))
          )
        )
        .run();

      if (claim.changes === 0) {
        return;
      }

      await this.handleSingleMerge(node);
    } catch (error) {
      const isPermanent = claimedAttempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(claimedAttempts);

      db.update(contextNodes)
        .set({
          mergeStatus: isPermanent ? "failed_permanent" : "failed",
          mergeAttempts: claimedAttempts,
          mergeNextRunAt: nextRun,
          mergeErrorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(contextNodes.id, node.id))
        .run();
    }
  }

  private async processVectorDocumentEmbeddingRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();

    if (!doc) return;

    // 已经成功则直接返回：可能是并发竞态或重复入队导致的。
    if (doc.embeddingStatus === "succeeded") return;

    try {
      // 1) 认领：置为 `running`
      const claim = db
        .update(vectorDocuments)
        .set({ embeddingStatus: "running", updatedAt: Date.now() })
        .where(
          and(
            eq(vectorDocuments.id, doc.id),
            or(
              eq(vectorDocuments.embeddingStatus, "pending"),
              eq(vectorDocuments.embeddingStatus, "failed")
            )
          )
        )
        .run();

      if (claim.changes === 0) {
        return;
      }

      // 2) 构造要生成向量的文本（当前约定 refId 指向 contextNodes）
      if (!doc.refId) {
        throw new Error("Vector document missing refId");
      }

      const text = await vectorDocumentService.buildTextForNode(doc.refId);

      // 3) 调用向量模型（embedding）
      const vector = await embeddingService.embed(text);

      // 4) 落库：Float32Array 向量 -> Buffer（二进制 BLOB）
      const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

      db.update(vectorDocuments)
        .set({
          embedding: buffer,
          embeddingStatus: "succeeded",
          embeddingNextRunAt: null,
          errorMessage: null,
          errorCode: null,
          // 向量生成成功后，触发 `index` 子任务进入 pending。
          indexStatus: "pending",
          indexAttempts: 0,
          indexNextRunAt: null,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();

      logger.debug({ docId: doc.id }, "Generated embedding for vector document");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = doc.embeddingAttempts + 1;
      const isPermanent = attempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);

      db.update(vectorDocuments)
        .set({
          embeddingStatus: isPermanent ? "failed_permanent" : "failed",
          embeddingAttempts: attempts,
          embeddingNextRunAt: nextRun,
          errorMessage: message,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();
    }
  }

  private async processVectorDocumentIndexRecord(record: PendingRecord): Promise<void> {
    const db = getDb();
    const doc = db.select().from(vectorDocuments).where(eq(vectorDocuments.id, record.id)).get();

    if (!doc) return;

    // 前置条件：embedding 必须先成功。
    if (doc.embeddingStatus !== "succeeded" || !doc.embedding) {
      // 理论上 scanPendingRecords 已保证该条件，这里是兜底。
      return;
    }

    try {
      // 1) 认领：置为 `running`
      const claim = db
        .update(vectorDocuments)
        .set({ indexStatus: "running", updatedAt: Date.now() })
        .where(
          and(
            eq(vectorDocuments.id, doc.id),
            or(
              eq(vectorDocuments.indexStatus, "pending"),
              eq(vectorDocuments.indexStatus, "failed")
            )
          )
        )
        .run();

      if (claim.changes === 0) {
        return;
      }

      // 2) 二进制 BLOB -> Float32Array 向量
      const buffer = doc.embedding as Buffer;
      const vector = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

      // 3) 写入/更新到本地 HNSW 索引（以 vector_documents.id 作为数值 ID）
      await vectorIndexService.upsert(doc.id, vector);
      vectorIndexService.requestFlush();

      // 4) 标记成功
      db.update(vectorDocuments)
        .set({
          indexStatus: "succeeded",
          indexNextRunAt: null,
          errorMessage: null,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();

      logger.debug({ docId: doc.id }, "Indexed vector document");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = doc.indexAttempts + 1;
      const isPermanent = attempts >= retryConfig.maxAttempts;
      const nextRun = isPermanent ? null : this.calculateNextRun(attempts);

      db.update(vectorDocuments)
        .set({
          indexStatus: isPermanent ? "failed_permanent" : "failed",
          indexAttempts: attempts,
          indexNextRunAt: nextRun,
          errorMessage: message,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, doc.id))
        .run();
    }
  }

  /**
   * 合并单个节点到上下文图谱。
   *
   * 调度语义：本函数由 `processContextNodeMergeRecord()` 触发，且在进入前已经 claim 了 mergeStatus。
   *
   * 合并策略（当前实现）：
   * - 仅在同 `threadId` + 同 `kind` 下尝试寻找 merge 目标。
   * - 目标选择为：同线程同 kind 且 `mergeStatus='succeeded'` 的最新节点。
   * - 如果没有 threadId 或找不到目标，则把自身视为“无需合并”，直接标记 succeeded。
   *
   * 合并副作用：
   * - 更新目标节点内容（title/summary/keywords/entities/...）。
   * - 把来源节点关联的截图 link 到目标节点。
   * - 标记来源节点 mergeStatus='succeeded'（表示已被吸收）。
   * - 触发向量文档同步与（可选）实体提及同步。
   */
  private async handleSingleMerge(nodeRecord: ContextNodeRecord): Promise<void> {
    // 1) DB 记录 -> ExpandedContextNode（用于 LLM merge 输入）
    const node: ExpandedContextNode = {
      id: nodeRecord.id,
      kind: nodeRecord.kind,
      threadId: nodeRecord.threadId ?? undefined,
      title: nodeRecord.title,
      summary: nodeRecord.summary,
      keywords: nodeRecord.keywords ? JSON.parse(nodeRecord.keywords) : [],
      entities: nodeRecord.entities ? JSON.parse(nodeRecord.entities) : [],
      importance: nodeRecord.importance,
      confidence: nodeRecord.confidence,
      eventTime: nodeRecord.eventTime ?? undefined,
      // screenshotIds 会在下面从图谱关系中补齐。
      screenshotIds: [],
      mergedFromIds: nodeRecord.mergedFromIds ? JSON.parse(nodeRecord.mergedFromIds) : [],
    };

    // 2) 读取该节点关联的截图（用于后续合并后重新关联）
    node.screenshotIds = contextGraphService.getLinkedScreenshots(nodeRecord.id.toString());

    // 没有 threadId 则无法在同一线程内找 merge 目标；视为自洽节点，直接成功。
    if (!node.threadId) {
      await contextGraphService.updateNode(nodeRecord.id.toString(), {
        mergeStatus: "succeeded",
      });
      return;
    }

    // 3) 找 merge 目标：同 threadId + 同 kind + 已 succeeded 的最新节点
    const targetRecord = getDb()
      .select()
      .from(contextNodes)
      .where(
        and(
          eq(contextNodes.threadId, node.threadId),
          eq(contextNodes.kind, node.kind),
          eq(contextNodes.mergeStatus, "succeeded"),
          ne(contextNodes.id, nodeRecord.id)
        )
      )
      .orderBy(desc(contextNodes.eventTime))
      .limit(1)
      .get() as ContextNodeRecord | undefined;

    if (!targetRecord) {
      // 没有可合并的目标：视为自洽节点，直接成功。
      await contextGraphService.updateNode(nodeRecord.id.toString(), {
        mergeStatus: "succeeded",
      });
      return;
    }

    // 4) 执行 LLM 合并
    const target: ExpandedContextNode = {
      id: targetRecord.id,
      kind: targetRecord.kind,
      threadId: targetRecord.threadId ?? undefined,
      title: targetRecord.title,
      summary: targetRecord.summary,
      keywords: targetRecord.keywords ? JSON.parse(targetRecord.keywords) : [],
      entities: targetRecord.entities ? JSON.parse(targetRecord.entities) : [],
      importance: targetRecord.importance,
      confidence: targetRecord.confidence,
      eventTime: targetRecord.eventTime ?? undefined,
      screenshotIds: contextGraphService.getLinkedScreenshots(targetRecord.id.toString()),
      mergedFromIds: targetRecord.mergedFromIds ? JSON.parse(targetRecord.mergedFromIds) : [],
    };

    const mergeResult = await textLLMProcessor.executeMerge(node, target);

    // 5) 落库：更新目标节点内容，并维护 mergedFromIds 以保留“被合并来源”谱系。
    await contextGraphService.updateNode(targetRecord.id.toString(), {
      title: mergeResult.mergedNode.title,
      summary: mergeResult.mergedNode.summary,
      keywords: mergeResult.mergedNode.keywords,
      entities: mergeResult.mergedNode.entities,
      importance: mergeResult.mergedNode.importance,
      confidence: mergeResult.mergedNode.confidence,
      mergedFromIds: mergeResult.mergedFromIds,
    });

    // 若目标节点是 event，则额外同步实体提及（失败不阻塞合并）。
    if (targetRecord.kind === "event") {
      try {
        await entityService.syncEventEntityMentions(
          targetRecord.id,
          mergeResult.mergedNode.entities,
          "llm"
        );
      } catch (err) {
        logger.warn(
          { targetId: targetRecord.id, error: String(err) },
          "Failed to sync entity mentions for merged target node"
        );
      }
    }

    // 把来源节点的截图全部关联到目标节点。
    for (const screenshotId of node.screenshotIds) {
      await contextGraphService.linkScreenshot(targetRecord.id.toString(), screenshotId.toString());
    }

    // 标记来源节点合并成功（表示已经被吸收进 target）。
    await contextGraphService.updateNode(nodeRecord.id.toString(), {
      mergeStatus: "succeeded",
    });

    // 目标节点内容发生变化后，同步其向量文档（失败不阻塞合并）。
    try {
      await vectorDocumentService.upsertForContextNode(targetRecord.id);
    } catch (err) {
      logger.warn(
        { targetId: targetRecord.id, error: String(err) },
        "Failed to upsert vector doc for merged target node"
      );
    }

    logger.info({ sourceId: node.id, targetId: target.id }, "Merged node into target");
  }

  /**
   * 计算下一次重试时间：指数退避 + 随机抖动。
   *
   * - `attempts` 从 1 开始。
   * - `backoffScheduleMs` 为离散表；超过长度则使用最后一个值。
   * - 随机抖动用于打散同一时刻大量任务同时重试造成的尖峰。
   */
  private calculateNextRun(attempts: number): number {
    const { backoffScheduleMs, jitterMs } = retryConfig;
    const baseDelay = backoffScheduleMs[Math.min(attempts - 1, backoffScheduleMs.length - 1)];
    const jitter = Math.random() * jitterMs;
    return Date.now() + baseDelay + jitter;
  }
}

export const reconcileLoop = new ReconcileLoop();
