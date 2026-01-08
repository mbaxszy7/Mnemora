import fs from "fs";
import path from "path";
import hnswlib from "hnswlib-node";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../database";
import { vectorDocuments } from "../../database/schema";
import { vectorStoreConfig } from "./config";
import { getLogger } from "../logger";

const logger = getLogger("vector-index-service");

// 当 DB 里还没有任何 embedding 时的兜底维度。
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_FLUSH_DEBOUNCE_MS = 500;

export class VectorIndexService {
  private index: hnswlib.HierarchicalNSW | null = null;
  private detectedDimensions: number | null = null;
  private loadPromise: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * 从数据库中探测 embedding 的维度。
   *
   * 原理：`vector_documents.embedding` 以 Float32Array 序列化后的 Buffer 存储。
   * 因此维度 = buffer.byteLength / 4。
   */
  private detectDimensionsFromDb(): number {
    const db = getDb();
    // 尝试从任意一条已有 embedding 的记录中读取维度。
    const doc = db
      .select({ embedding: vectorDocuments.embedding })
      .from(vectorDocuments)
      .where(isNotNull(vectorDocuments.embedding))
      .limit(1)
      .get();

    if (doc?.embedding) {
      const buffer = doc.embedding as Buffer;
      const dims = buffer.byteLength / 4; // Float32 = 4 bytes
      logger.info({ detectedDimensions: dims }, "Detected embedding dimensions from database");
      return dims;
    }

    logger.info(
      { defaultDimensions: DEFAULT_DIMENSIONS },
      "No existing embeddings, using default dimensions"
    );
    return DEFAULT_DIMENSIONS;
  }

  /**
   * 从磁盘加载 HNSW 索引；如果不存在或加载失败，则创建新索引。
   *
   * 注意：本索引是“DB 的派生物”。
   * - 真实的状态机在 `vector_documents` 表里（indexStatus 等）。
   * - 本地索引丢失/重建后，需要把 DB 中的 `indexStatus=succeeded` 重置为 pending，
   *   让 VectorDocumentScheduler 重新把 embedding 写入索引，以保持一致性。
   */
  async load(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const { indexFilePath } = vectorStoreConfig;
    const db = getDb();

    this.loadPromise = (async () => {
      // 1) 探测维度。
      this.detectedDimensions = this.detectDimensionsFromDb();

      // 2) 估算容量：当前 doc 数 + 预留 headroom。
      const [{ value }] = db.select({ value: count() }).from(vectorDocuments).all();
      // 初始容量：当前 docs + 5000 预留。
      const neededCapacity = Number(value ?? 0) + 5000;

      // 3) 确保索引目录存在。
      const dir = path.dirname(indexFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(indexFilePath)) {
        try {
          this.index = new hnswlib.HierarchicalNSW("l2", this.detectedDimensions);
          this.index.readIndexSync(indexFilePath);

          // 加载后如果容量不足，立即扩容。
          if (this.index.getMaxElements() < neededCapacity) {
            logger.info(
              { oldMax: this.index.getMaxElements(), newMax: neededCapacity },
              "Resizing index on load"
            );
            this.index.resizeIndex(neededCapacity);
          }

          logger.info(
            {
              path: indexFilePath,
              dimensions: this.detectedDimensions,
              currentCount: this.index.getCurrentCount(),
              maxElements: this.index.getMaxElements(),
            },
            "Loaded vector index"
          );
        } catch (err) {
          logger.error({ error: err }, "Failed to load index from file, creating fresh index");
          this.createFreshIndex(neededCapacity);
          this.resetSucceededIndexStatuses();
        }
      } else {
        this.createFreshIndex(neededCapacity);
        this.resetSucceededIndexStatuses();
      }
    })();

    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  /**
   * 当本地索引被重建（或加载失败）时，把 DB 中“已 index succeeded”的记录重置为 pending。
   *
   * 目的：让 VectorDocumentScheduler 重新执行 index 子任务，把 embedding 写回新索引，
   * 避免出现“DB 认为已索引，但本地索引实际为空/丢失”的不一致。
   */
  private resetSucceededIndexStatuses(): void {
    const db = getDb();
    const now = Date.now();

    db.update(vectorDocuments)
      .set({
        indexStatus: "pending",
        indexAttempts: 0,
        indexNextRunAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(vectorDocuments.embeddingStatus, "succeeded"),
          eq(vectorDocuments.indexStatus, "succeeded")
        )
      )
      .run();
  }

  private createFreshIndex(capacity: number) {
    if (!this.detectedDimensions) {
      this.detectedDimensions = this.detectDimensionsFromDb();
    }
    this.index = new hnswlib.HierarchicalNSW("l2", this.detectedDimensions);
    this.index.initIndex(capacity);
    logger.info({ capacity, dimensions: this.detectedDimensions }, "Created fresh vector index");
  }

  /**
   * 将索引写入磁盘。
   *
   * 写入是同步的（hnswlib 的 writeIndexSync），因此上层会用 requestFlush() 做 debounce
   * 来降低频繁 IO。
   */
  async flush(): Promise<void> {
    if (!this.index) return;
    const { indexFilePath } = vectorStoreConfig;
    try {
      this.index.writeIndexSync(indexFilePath);
      logger.debug("Flushed vector index to disk");
    } catch (err) {
      logger.error({ error: err }, "Failed to flush vector index");
      throw err;
    }
  }

  /**
   * 把一条向量写入/更新到 HNSW 索引。
   *
   * 约定：label 使用 `vector_documents.id`（docId）。这样查询返回的 neighbors 可以直接回表。
   */
  async upsert(docId: number, embedding: Float32Array): Promise<void> {
    // JS 侧是单线程；调度器已经做了 claim 限制并发。这里主要保证 index 已初始化。
    if (!this.index) {
      await this.load();
    }
    if (!this.index) throw new Error("Index not initialized");

    if (this.detectedDimensions && embedding.length !== this.detectedDimensions) {
      throw new Error(
        `Embedding dimensions mismatch: expected ${this.detectedDimensions}, got ${embedding.length}`
      );
    }

    try {
      const currentCount = this.index.getCurrentCount();
      const maxElements = this.index.getMaxElements();

      // 容量不足自动扩容。
      // 注：getCurrentCount 可能包含已删除元素；这里采取保守策略，接近上限就扩容。
      if (currentCount >= maxElements) {
        const newMax = maxElements + 5000;
        logger.info({ currentCount, maxElements, newMax }, "Auto-resizing index during upsert");
        this.index.resizeIndex(newMax);
      }

      // addPoint(vector, label)：通常会覆盖同 label 的旧值。
      this.index.addPoint(Array.from(embedding), docId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("dimensions mismatch")) {
        // 维度不一致：重建索引，并重置 DB 状态，让 index 子任务重试。
        const capacity = this.index?.getMaxElements() ?? 5000;
        this.createFreshIndex(capacity);
        this.resetSucceededIndexStatuses();
      }
      logger.error({ error: err, docId }, "Failed to upsert vector");
      throw err;
    }
  }

  /**
   * 语义检索：返回 topK 个近邻。
   *
   * 注意：这里的 score 是 L2 distance（越小越相似）。
   */
  async search(
    queryEmbedding: Float32Array,
    topK: number
  ): Promise<Array<{ docId: number; score: number }>> {
    if (!this.index) {
      await this.load();
    }
    if (!this.index || this.index.getCurrentCount() === 0) {
      return [];
    }

    if (this.detectedDimensions && queryEmbedding.length !== this.detectedDimensions) {
      throw new Error(
        `Query embedding dimensions mismatch: expected ${this.detectedDimensions}, got ${queryEmbedding.length}`
      );
    }

    try {
      // searchKnn 返回 { distances, neighbors }，neighbors 即 labels（docIds）。
      const result = this.index.searchKnn(Array.from(queryEmbedding), topK);
      const { distances, neighbors } = result;

      return neighbors.map((docId, i) => ({
        docId,
        score: distances[i], // L2 distance
      }));
    } catch (err) {
      logger.error({ error: err, topK }, "Vector search failed");
      throw err;
    }
  }

  /**
   * 从索引中删除（软删除）：markDelete。
   *
   * 注：这不会改 DB；通常用于数据删除/回收场景。
   */
  async remove(docId: number): Promise<void> {
    if (!this.index) return;
    try {
      this.index.markDelete(docId);
    } catch (err) {
      // Ignore error if element doesn't exist
      logger.debug({ docId, error: err }, "Failed to markDelete (likely not found)");
    }
  }

  /**
   * 请求落盘（debounce）。
   *
   * 场景：index 子任务可能短时间 upsert 很多点，如果每次都 writeIndexSync 会产生明显 IO 压力。
   * 因此这里用 setTimeout 做一次合并写。
   */
  requestFlush(): void {
    const delay = vectorStoreConfig.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      try {
        await this.flush();
      } catch (err) {
        logger.error({ error: err }, "Debounced flush failed");
      }
    }, delay);
  }
}

export const vectorIndexService = new VectorIndexService();
