/**
 * Batch Builder
 *
 * Responsible for:
 * - Creating batches from accepted screenshots
 * - Generating idempotency keys for deduplication
 * - Building history packs for VLM context
 * - Splitting batches into shards for parallel processing
 * - Persisting batches to SQLite
 *
 * Design reference: design.md Section 4.3 批次构建
 */

import crypto from "node:crypto";
import { eq, desc, and, gte, isNotNull, inArray, isNull } from "drizzle-orm";

import { getDb } from "../../database";
import {
  batches,
  contextNodes,
  contextEdges,
  screenshots,
  type NewBatchRecord,
} from "../../database/schema";
import { getLogger } from "../logger";
import { vlmConfig, historyPackConfig } from "./config";
import type {
  AcceptedScreenshot,
  Batch,
  Shard,
  HistoryPack,
  ThreadSummary,
  SegmentSummary,
  ScreenshotWithData,
  SourceKey,
} from "./types";

const logger = getLogger("batch-builder");

// ============================================================================
// BatchBuilder Class
// ============================================================================

/**
 * BatchBuilder creates and manages batches for VLM processing
 */
export class BatchBuilder {
  private readonly shardSize: number;
  private readonly recentThreadsLimit: number;
  private readonly recentEntitiesLimit: number;
  private readonly openSegmentWindowMs: number;
  private readonly summaryCharLimit: number;

  constructor(options?: {
    shardSize?: number;
    recentThreadsLimit?: number;
    recentEntitiesLimit?: number;
    openSegmentWindowMs?: number;
    summaryCharLimit?: number;
  }) {
    this.shardSize = options?.shardSize ?? vlmConfig.vlmShardSize;
    this.recentThreadsLimit = options?.recentThreadsLimit ?? historyPackConfig.recentThreadsLimit;
    this.recentEntitiesLimit =
      options?.recentEntitiesLimit ?? historyPackConfig.recentEntitiesLimit;
    this.openSegmentWindowMs =
      options?.openSegmentWindowMs ?? historyPackConfig.openSegmentWindowMs;
    this.summaryCharLimit = options?.summaryCharLimit ?? historyPackConfig.summaryCharLimit;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Create a batch from accepted screenshots
   *
   * @param sourceKey - Source identifier
   * @param screenshots - Screenshots to include in the batch
   * @returns Created batch with idempotency key
   */
  createBatch(sourceKey: SourceKey, screenshots: AcceptedScreenshot[]): Batch {
    if (screenshots.length === 0) {
      throw new Error("Cannot create batch with empty screenshots");
    }

    // Sort screenshots by timestamp to ensure time order
    const sortedScreenshots = [...screenshots].sort((a, b) => a.ts - b.ts);

    const tsStart = sortedScreenshots[0].ts;
    const tsEnd = sortedScreenshots[sortedScreenshots.length - 1].ts;

    // Generate unique batch ID
    const batchId = this.generateBatchId();

    // Generate idempotency key
    const idempotencyKey = this.generateIdempotencyKey(
      sourceKey,
      tsStart,
      tsEnd,
      sortedScreenshots
    );

    const batch: Batch = {
      batchId,
      sourceKey,
      screenshots: sortedScreenshots,
      status: "pending",
      idempotencyKey,
      tsStart,
      tsEnd,
    };

    logger.debug(
      {
        batchId,
        sourceKey,
        screenshotCount: sortedScreenshots.length,
        tsStart,
        tsEnd,
        idempotencyKey,
      },
      "Created batch"
    );

    return batch;
  }

  /**
   * Build history pack for VLM context
   *
   * Queries:
   * - Recent 3 active threads with their latest event
   * - Open segments within time window (15 min)
   * - Recent 10 mentioned entities
   *
   * @param sourceKey - Source identifier for filtering open segments
   * @returns History pack for VLM context
   */
  buildHistoryPack(sourceKey: SourceKey): HistoryPack {
    const db = getDb();
    const now = Date.now();

    // Query recent threads with their latest event
    const recentThreads = this.queryRecentThreads(db);

    // Query open segments for this source
    const openSegments = this.queryOpenSegments(db, sourceKey, now);

    // Query recent entities
    const recentEntities = this.queryRecentEntities(db);

    const historyPack: HistoryPack = {
      recentThreads,
      openSegments,
      recentEntities,
    };

    logger.debug(
      {
        sourceKey,
        recentThreadsCount: recentThreads.length,
        openSegmentsCount: openSegments.length,
        recentEntitiesCount: recentEntities.length,
      },
      "Built history pack"
    );

    return historyPack;
  }

  /**
   * Split batch into shards for parallel VLM processing
   *
   * Ensures:
   * - Each shard has at most `shardSize` screenshots (default 5)
   * - Time order is preserved across shards
   * - All shards share the same history pack
   *
   * @param batch - Batch to split (must have historyPack)
   * @param shardSize - Maximum screenshots per shard (optional, uses config default)
   * @returns Array of shards
   */
  splitIntoShards(batch: Batch, shardSize?: number): Shard[] {
    const size = shardSize ?? this.shardSize;

    if (!batch.historyPack) {
      throw new Error("Cannot split batch without historyPack");
    }

    const historyPack = batch.historyPack;

    // Screenshots should already be sorted by ts from createBatch
    const sortedScreenshots = batch.screenshots;

    const shards: Shard[] = [];
    let shardIndex = 0;

    for (let i = 0; i < sortedScreenshots.length; i += size) {
      const shardScreenshots = sortedScreenshots.slice(i, i + size);

      // Convert to ScreenshotWithData (base64 will be populated later by VLM processor)
      const screenshotsWithData: ScreenshotWithData[] = shardScreenshots.map((s) => ({
        ...s,
        base64: "", // Will be populated when loading images for VLM
      }));

      shards.push({
        shardIndex,
        screenshots: screenshotsWithData,
        historyPack, // Same history pack for all shards (CP-6)
      });

      shardIndex++;
    }

    logger.debug(
      {
        batchId: batch.batchId,
        totalScreenshots: sortedScreenshots.length,
        shardCount: shards.length,
        shardSize: size,
      },
      "Split batch into shards"
    );

    return shards;
  }

  /**
   * Persist batch to SQLite with status 'pending'
   *
   * @param batch - Batch to persist
   * @param historyPack - History pack to store with batch
   * @returns Database record ID
   */
  private async persistBatch(batch: Batch, historyPack: HistoryPack): Promise<number> {
    const db = getDb();
    const now = Date.now();
    const screenshotIds = batch.screenshots.map((s) => s.id);

    const dbId = db.transaction((tx) => {
      const record: NewBatchRecord = {
        batchId: batch.batchId,
        sourceKey: batch.sourceKey,
        screenshotIds: JSON.stringify(screenshotIds),
        tsStart: batch.tsStart,
        tsEnd: batch.tsEnd,
        historyPack: JSON.stringify(historyPack),
        idempotencyKey: batch.idempotencyKey,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };

      let batchDbId: number;
      try {
        const inserted = tx.insert(batches).values(record).returning({ id: batches.id }).get();
        batchDbId = inserted.id;
      } catch (error) {
        const existing = tx
          .select({ id: batches.id })
          .from(batches)
          .where(eq(batches.idempotencyKey, batch.idempotencyKey))
          .get();
        if (!existing) {
          throw error;
        }
        batchDbId = existing.id;
      }

      if (screenshotIds.length > 0) {
        const existingEnqueue = tx
          .select({ id: screenshots.id, enqueuedBatchId: screenshots.enqueuedBatchId })
          .from(screenshots)
          .where(inArray(screenshots.id, screenshotIds))
          .all();

        const conflict = existingEnqueue.find(
          (s) => s.enqueuedBatchId != null && s.enqueuedBatchId !== batchDbId
        );
        if (conflict) {
          throw new Error(
            `Screenshot ${conflict.id} is already enqueued to batch ${conflict.enqueuedBatchId}`
          );
        }

        tx.update(screenshots)
          .set({ enqueuedBatchId: batchDbId, updatedAt: now })
          .where(and(inArray(screenshots.id, screenshotIds), isNull(screenshots.enqueuedBatchId)))
          .run();
      }

      return batchDbId;
    });

    logger.info(
      {
        id: dbId,
        batchId: batch.batchId,
        sourceKey: batch.sourceKey,
        screenshotCount: batch.screenshots.length,
      },
      "Persisted batch to database"
    );

    return dbId;
  }

  /**
   * Create batch, build history pack, and persist to database
   *
   * Convenience method that combines createBatch, buildHistoryPack, and persistBatch
   *
   * @param sourceKey - Source identifier
   * @param screenshots - Screenshots to include in the batch
   * @returns Object containing batch and database ID
   */
  async createAndPersistBatch(
    sourceKey: SourceKey,
    screenshots: AcceptedScreenshot[]
  ): Promise<{ batch: Batch; dbId: number }> {
    const batch = this.createBatch(sourceKey, screenshots);
    const historyPack = this.buildHistoryPack(sourceKey);
    batch.historyPack = historyPack;
    const dbId = await this.persistBatch(batch, historyPack);

    return { batch, dbId };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Generate unique batch ID
   */
  private generateBatchId(): string {
    return `batch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  /**
   * Generate idempotency key for batch
   * Format: vlm_batch:<source_key>:<ts_start>-<ts_end>:<hash>
   */
  private generateIdempotencyKey(
    sourceKey: SourceKey,
    tsStart: number,
    tsEnd: number,
    screenshots: AcceptedScreenshot[]
  ): string {
    // Create hash from screenshot IDs to ensure uniqueness
    const screenshotIds = screenshots.map((s) => s.id).sort((a, b) => a - b);
    const hash = crypto
      .createHash("sha256")
      .update(screenshotIds.join(","))
      .digest("hex")
      .substring(0, 8);

    return `vlm_batch:${sourceKey}:${tsStart}-${tsEnd}:${hash}`;
  }

  /**
   * Query recent threads with their latest event
   */
  private queryRecentThreads(db: ReturnType<typeof getDb>): ThreadSummary[] {
    try {
      // Get distinct thread IDs from recent events, ordered by most recent event time
      const recentEvents = db
        .select({
          threadId: contextNodes.threadId,
          title: contextNodes.title,
          summary: contextNodes.summary,
          eventTime: contextNodes.eventTime,
        })
        .from(contextNodes)
        .where(
          and(
            eq(contextNodes.kind, "event"),
            // Only include nodes with thread_id
            isNotNull(contextNodes.threadId)
          )
        )
        .orderBy(desc(contextNodes.eventTime))
        .limit(50) // Get more to dedupe by thread
        .all();

      // Dedupe by thread_id and take top N
      const seenThreads = new Set<string>();
      const threads: ThreadSummary[] = [];

      for (const event of recentEvents) {
        if (!event.threadId || seenThreads.has(event.threadId)) {
          continue;
        }

        seenThreads.add(event.threadId);
        threads.push({
          threadId: event.threadId,
          title: event.title,
          lastEventSummary: this.truncateSummary(event.summary),
          lastEventTs: event.eventTime ?? 0,
        });

        if (threads.length >= this.recentThreadsLimit) {
          break;
        }
      }

      return threads;
    } catch (error) {
      logger.warn({ error }, "Failed to query recent threads, returning empty array");
      return [];
    }
  }

  /**
   * Query open segments for a source within time window
   */
  private queryOpenSegments(
    db: ReturnType<typeof getDb>,
    sourceKey: SourceKey,
    now: number
  ): SegmentSummary[] {
    try {
      const windowStart = now - this.openSegmentWindowMs;

      // Query events that might be open segments
      // An "open segment" is an event without a following event_next edge
      // For simplicity, we query recent events from this source that are within the time window
      const recentEvents = db
        .select({
          id: contextNodes.id,
          threadId: contextNodes.threadId,
          summary: contextNodes.summary,
          eventTime: contextNodes.eventTime,
        })
        .from(contextNodes)
        .where(and(eq(contextNodes.kind, "event"), gte(contextNodes.eventTime, windowStart)))
        .orderBy(desc(contextNodes.eventTime))
        .limit(10)
        .all();

      // Filter to find events without outgoing event_next edges (open segments)
      const openSegments: SegmentSummary[] = [];

      for (const event of recentEvents) {
        // Check if this event has an outgoing event_next edge
        const hasNextEdge = db
          .select({ id: contextEdges.id })
          .from(contextEdges)
          .where(
            and(eq(contextEdges.fromNodeId, event.id), eq(contextEdges.edgeType, "event_next"))
          )
          .get();

        if (!hasNextEdge) {
          openSegments.push({
            segmentId: `segment_${event.id}`,
            summary: this.truncateSummary(event.summary),
            sourceKey,
            startTs: event.eventTime ?? 0,
          });
        }

        if (openSegments.length >= 5) {
          break;
        }
      }

      return openSegments;
    } catch (error) {
      logger.warn({ error }, "Failed to query open segments, returning empty array");
      return [];
    }
  }

  /**
   * Query recent entities mentioned in events
   */
  private queryRecentEntities(db: ReturnType<typeof getDb>): string[] {
    try {
      // Get recent events with entities
      const recentEvents = db
        .select({
          entities: contextNodes.entities,
        })
        .from(contextNodes)
        .where(
          and(
            eq(contextNodes.kind, "event"),
            // Only include nodes with entities
            isNotNull(contextNodes.entities)
          )
        )
        .orderBy(desc(contextNodes.eventTime))
        .limit(20)
        .all();

      // Extract unique entity names
      const entitySet = new Set<string>();

      for (const event of recentEvents) {
        if (!event.entities) continue;

        try {
          const entities = JSON.parse(event.entities) as Array<{ name: string }>;
          for (const entity of entities) {
            if (entity.name) {
              entitySet.add(entity.name);
            }
            if (entitySet.size >= this.recentEntitiesLimit) {
              break;
            }
          }
        } catch {
          // Skip malformed JSON
        }

        if (entitySet.size >= this.recentEntitiesLimit) {
          break;
        }
      }

      return Array.from(entitySet);
    } catch (error) {
      logger.warn({ error }, "Failed to query recent entities, returning empty array");
      return [];
    }
  }

  /**
   * Truncate summary to configured character limit
   */
  private truncateSummary(summary: string): string {
    if (summary.length <= this.summaryCharLimit) {
      return summary;
    }
    return summary.substring(0, this.summaryCharLimit - 3) + "...";
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const batchBuilder = new BatchBuilder();
