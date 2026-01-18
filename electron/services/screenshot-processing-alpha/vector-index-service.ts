import fs from "fs";
import path from "path";
import hnswlib from "hnswlib-node";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../database";
import { vectorDocuments } from "../../database/schema";
import { processingConfig } from "./config";
import { getLogger } from "../logger";

const logger = getLogger("vector-index-service");

export class VectorIndexService {
  private index: hnswlib.HierarchicalNSW | null = null;
  private detectedDimensions: number | null = null;
  private loadPromise: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  private detectDimensionsFromDb(): number {
    const db = getDb();
    const doc = db
      .select({ embedding: vectorDocuments.embedding })
      .from(vectorDocuments)
      .where(isNotNull(vectorDocuments.embedding))
      .limit(1)
      .get();

    if (doc?.embedding) {
      const buffer = doc.embedding as Buffer;
      const dims = buffer.byteLength / 4;
      logger.info({ detectedDimensions: dims }, "Detected embedding dimensions from database");
      return dims;
    }

    logger.info(
      { defaultDimensions: processingConfig.vectorStore.defaultDimensions },
      "No existing embeddings, using default dimensions"
    );
    return processingConfig.vectorStore.defaultDimensions;
  }

  async load(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const { indexFilePath } = processingConfig.vectorStore;
    const db = getDb();

    this.loadPromise = (async () => {
      this.detectedDimensions = this.detectDimensionsFromDb();

      const [{ value }] = db.select({ value: count() }).from(vectorDocuments).all();
      const neededCapacity = Number(value ?? 0) + 5000;

      const dir = path.dirname(indexFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(indexFilePath)) {
        try {
          this.index = new hnswlib.HierarchicalNSW("l2", this.detectedDimensions);
          this.index.readIndexSync(indexFilePath);

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

  private resetAllEmbeddingsForDimensionChange(): void {
    const db = getDb();
    const now = Date.now();

    db.update(vectorDocuments)
      .set({
        embedding: null,
        embeddingStatus: "pending",
        embeddingAttempts: 0,
        embeddingNextRunAt: null,
        indexStatus: "pending",
        indexAttempts: 0,
        indexNextRunAt: null,
        updatedAt: now,
      })
      .run();

    logger.info("Reset all embeddings for dimension change");
  }

  private createFreshIndex(capacity: number, newDimensions?: number) {
    if (newDimensions !== undefined) {
      this.detectedDimensions = newDimensions;
    } else if (!this.detectedDimensions) {
      this.detectedDimensions = this.detectDimensionsFromDb();
    }
    this.index = new hnswlib.HierarchicalNSW("l2", this.detectedDimensions);
    this.index.initIndex(capacity);
    logger.info({ capacity, dimensions: this.detectedDimensions }, "Created fresh vector index");
  }

  async flush(): Promise<void> {
    if (!this.index) return;
    const { indexFilePath } = processingConfig.vectorStore;
    try {
      this.index.writeIndexSync(indexFilePath);
      logger.debug("Flushed vector index to disk");
    } catch (err) {
      logger.error({ error: err }, "Failed to flush vector index");
      throw err;
    }
  }

  async upsert(docId: number, embedding: Float32Array): Promise<void> {
    if (!this.index) {
      await this.load();
    }
    if (!this.index) throw new Error("Index not initialized");

    if (this.detectedDimensions && embedding.length !== this.detectedDimensions) {
      logger.warn(
        {
          oldDimensions: this.detectedDimensions,
          newDimensions: embedding.length,
          docId,
        },
        "Embedding dimension change detected, triggering dimension migration"
      );

      const capacity = this.index?.getMaxElements() ?? 5000;
      this.createFreshIndex(capacity, embedding.length);
      this.resetAllEmbeddingsForDimensionChange();

      throw new Error(
        `Dimension migration triggered: ${this.detectedDimensions} dimensions. All embeddings reset to pending.`
      );
    }

    try {
      const currentCount = this.index.getCurrentCount();
      const maxElements = this.index.getMaxElements();

      if (currentCount >= maxElements) {
        const newMax = maxElements + 5000;
        logger.info({ currentCount, maxElements, newMax }, "Auto-resizing index during upsert");
        this.index.resizeIndex(newMax);
      }

      this.index.addPoint(Array.from(embedding), docId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("dimensions mismatch") && !message.includes("migration triggered")) {
        const capacity = this.index?.getMaxElements() ?? 5000;
        this.createFreshIndex(capacity, embedding.length);
        this.resetAllEmbeddingsForDimensionChange();
      }
      logger.error({ error: err, docId }, "Failed to upsert vector");
      throw err;
    }
  }

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
      logger.warn(
        {
          expectedDimensions: this.detectedDimensions,
          queryDimensions: queryEmbedding.length,
        },
        "Query embedding dimensions mismatch, returning empty results"
      );
      return [];
    }

    try {
      const result = this.index.searchKnn(Array.from(queryEmbedding), topK);
      const { distances, neighbors } = result;

      return neighbors.map((docId, i) => ({
        docId,
        score: distances[i],
      }));
    } catch (err) {
      logger.error({ error: err, topK }, "Vector search failed");
      throw err;
    }
  }

  async remove(docId: number): Promise<void> {
    if (!this.index) return;
    try {
      this.index.markDelete(docId);
    } catch (err) {
      logger.debug({ docId, error: err }, "Failed to markDelete (likely not found)");
    }
  }

  requestFlush(): void {
    const delay = processingConfig.vectorStore.flushDebounceMs;
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
