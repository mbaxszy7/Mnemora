import fs from "fs";
import path from "path";
import hnswlib from "hnswlib-node";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../database";
import { vectorDocuments } from "../../database/schema";
import { vectorStoreConfig } from "./config";
import { getLogger } from "../logger";

const logger = getLogger("vector-index-service");

// Default dimension if no embeddings exist yet
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_FLUSH_DEBOUNCE_MS = 500;

export class VectorIndexService {
  private index: hnswlib.HierarchicalNSW | null = null;
  private detectedDimensions: number | null = null;
  private loadPromise: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Detect embedding dimensions from existing documents
   */
  private detectDimensionsFromDb(): number {
    const db = getDb();
    // Try to get dimensions from an existing embedding
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
   * Load the index from disk or create a fresh one
   */
  async load(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const { indexFilePath } = vectorStoreConfig;
    const db = getDb();

    this.loadPromise = (async () => {
      // Detect dimensions from existing embeddings
      this.detectedDimensions = this.detectDimensionsFromDb();

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
          this.index = new hnswlib.HierarchicalNSW("l2", this.detectedDimensions);
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

  private createFreshIndex(capacity: number) {
    if (!this.detectedDimensions) {
      this.detectedDimensions = this.detectDimensionsFromDb();
    }
    this.index = new hnswlib.HierarchicalNSW("l2", this.detectedDimensions);
    this.index.initIndex(capacity);
    logger.info({ capacity, dimensions: this.detectedDimensions }, "Created fresh vector index");
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

    if (this.detectedDimensions && embedding.length !== this.detectedDimensions) {
      throw new Error(
        `Embedding dimensions mismatch: expected ${this.detectedDimensions}, got ${embedding.length}`
      );
    }

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
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("dimensions mismatch")) {
        // Rebuild index and reset statuses so index tasks can retry with correct dims
        const capacity = this.index?.getMaxElements() ?? 5000;
        this.createFreshIndex(capacity);
        this.resetSucceededIndexStatuses();
      }
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

    if (this.detectedDimensions && queryEmbedding.length !== this.detectedDimensions) {
      throw new Error(
        `Query embedding dimensions mismatch: expected ${this.detectedDimensions}, got ${queryEmbedding.length}`
      );
    }

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

  /**
   * Debounced flush to reduce IO pressure when indexing many vectors.
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
