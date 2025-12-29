import fs from "fs";
import path from "path";
import hnswlib from "hnswlib-node";
import { and, count, eq } from "drizzle-orm";
import { getDb } from "../../database";
import { vectorDocuments } from "../../database/schema";
import { vectorStoreConfig } from "./config";
import { getLogger } from "../logger";

const logger = getLogger("vector-index-service");

export class VectorIndexService {
  private index: hnswlib.HierarchicalNSW | null = null;

  private assertNumDimensions(vector: Float32Array): void {
    const { numDimensions } = vectorStoreConfig;
    if (vector.length !== numDimensions) {
      throw new Error(
        `Invalid embedding dimensions: expected ${numDimensions}, got ${vector.length}`
      );
    }
  }

  /**
   * Load the index from disk or create a fresh one
   */
  async load(): Promise<void> {
    const { indexFilePath, numDimensions } = vectorStoreConfig;
    const db = getDb();

    // Calculate needed capacity
    const [{ value }] = db.select({ value: count() }).from(vectorDocuments).all();
    // Initial capacity: current docs + 5000 headroom
    const neededCapacity = Number(value ?? 0) + 5000;

    // Ensure directory exists
    const dir = path.dirname(indexFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(indexFilePath)) {
      try {
        this.index = new hnswlib.HierarchicalNSW("l2", numDimensions);
        this.index.readIndexSync(indexFilePath);

        // Check if we need to resize immediately upon loading
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

  private createFreshIndex(capacity: number) {
    const { numDimensions } = vectorStoreConfig;
    this.index = new hnswlib.HierarchicalNSW("l2", numDimensions);
    this.index.initIndex(capacity);
    logger.info({ capacity }, "Created fresh vector index");
  }

  /**
   * Write the index to disk
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
   * Insert or update a vector in the index
   */
  async upsert(docId: number, embedding: Float32Array): Promise<void> {
    // Determine lock/concurrency? HNSWLib addPoint is thread-safish in C++ but here we are single threaded JS.
    if (!this.index) {
      await this.load();
    }
    if (!this.index) throw new Error("Index not initialized");

    this.assertNumDimensions(embedding);

    try {
      const currentCount = this.index.getCurrentCount();
      const maxElements = this.index.getMaxElements();

      // Auto-resize if full
      // Note: getCurrentCount might include deleted elements depending on implementation,
      // but assuming we are near limit, we resize.
      if (currentCount >= maxElements) {
        const newMax = maxElements + 5000;
        logger.info({ currentCount, maxElements, newMax }, "Auto-resizing index during upsert");
        this.index.resizeIndex(newMax);
      }

      // addPoint(vector, label) - replaces if label exists (usually)
      this.index.addPoint(Array.from(embedding), docId);
    } catch (err) {
      logger.error({ error: err, docId }, "Failed to upsert vector");
      throw err;
    }
  }

  /**
   * Search for nearest neighbors
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

    this.assertNumDimensions(queryEmbedding);

    try {
      // searchKnn returns { distances, neighbors }
      // neighbors are the labels (docIds)
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
   * Remove a document from the index (mark as deleted)
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
}

export const vectorIndexService = new VectorIndexService();
