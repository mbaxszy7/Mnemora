import { sql } from "drizzle-orm";
import { getDb } from "../../database";
import { batches, vectorDocuments, activitySummaries, contextNodes } from "../../database/schema";
import { getLogger } from "../logger";
import type { QueueStatus } from "./monitoring-types";

const logger = getLogger("queue-inspector");

/**
 * QueueInspector
 *
 * Queries database for current queue depths across all background task types.
 * Used by MonitoringServer to provide real-time queue status.
 *
 * This service performs on-demand queries (not cached) to ensure accuracy.
 */
export class QueueInspector {
  private static instance: QueueInspector | null = null;

  private constructor() {}

  static getInstance(): QueueInspector {
    if (!QueueInspector.instance) {
      QueueInspector.instance = new QueueInspector();
    }
    return QueueInspector.instance;
  }

  /**
   * Get current queue status across all task types
   */
  async getQueueStatus(): Promise<QueueStatus> {
    const ts = Date.now();

    try {
      const db = getDb();

      // Batch status counts
      const batchCounts = await this.countByStatus(db, batches, "status");

      // Vector documents - embedding status
      const vectorEmbeddingCounts = await this.countByStatus(
        db,
        vectorDocuments,
        "embeddingStatus"
      );

      // Vector documents - index status
      const vectorIndexCounts = await this.countByStatus(db, vectorDocuments, "indexStatus");

      // Activity summaries status
      const activitySummaryCounts = await this.countByStatus(db, activitySummaries, "status");

      // Context nodes - merge status
      const contextMergeCounts = await this.countByStatus(db, contextNodes, "mergeStatus");

      // Context nodes - embedding status
      const contextEmbeddingCounts = await this.countByStatus(db, contextNodes, "embeddingStatus");

      return {
        ts,
        batches: {
          pending: batchCounts.get("pending") ?? 0,
          running: batchCounts.get("running") ?? 0,
          failed: (batchCounts.get("failed") ?? 0) + (batchCounts.get("failed_permanent") ?? 0),
        },
        vectorDocuments: {
          embeddingPending: vectorEmbeddingCounts.get("pending") ?? 0,
          embeddingRunning: vectorEmbeddingCounts.get("running") ?? 0,
          indexPending: vectorIndexCounts.get("pending") ?? 0,
          indexRunning: vectorIndexCounts.get("running") ?? 0,
          failed:
            (vectorEmbeddingCounts.get("failed") ?? 0) +
            (vectorEmbeddingCounts.get("failed_permanent") ?? 0) +
            (vectorIndexCounts.get("failed") ?? 0) +
            (vectorIndexCounts.get("failed_permanent") ?? 0),
        },
        activitySummaries: {
          pending: activitySummaryCounts.get("pending") ?? 0,
          running: activitySummaryCounts.get("running") ?? 0,
          failed:
            (activitySummaryCounts.get("failed") ?? 0) +
            (activitySummaryCounts.get("failed_permanent") ?? 0),
        },
        contextNodes: {
          mergePending: contextMergeCounts.get("pending") ?? 0,
          mergeRunning: contextMergeCounts.get("running") ?? 0,
          embeddingPending: contextEmbeddingCounts.get("pending") ?? 0,
          embeddingRunning: contextEmbeddingCounts.get("running") ?? 0,
        },
      };
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to get queue status"
      );

      // Return empty status on error
      return {
        ts,
        batches: { pending: 0, running: 0, failed: 0 },
        vectorDocuments: {
          embeddingPending: 0,
          embeddingRunning: 0,
          indexPending: 0,
          indexRunning: 0,
          failed: 0,
        },
        activitySummaries: { pending: 0, running: 0, failed: 0 },
        contextNodes: {
          mergePending: 0,
          mergeRunning: 0,
          embeddingPending: 0,
          embeddingRunning: 0,
        },
      };
    }
  }

  /**
   * Get total pending items across all queues (for health indicator)
   */
  async getTotalPendingCount(): Promise<number> {
    const status = await this.getQueueStatus();
    return (
      status.batches.pending +
      status.batches.running +
      status.vectorDocuments.embeddingPending +
      status.vectorDocuments.embeddingRunning +
      status.vectorDocuments.indexPending +
      status.vectorDocuments.indexRunning +
      status.activitySummaries.pending +
      status.activitySummaries.running +
      status.contextNodes.mergePending +
      status.contextNodes.mergeRunning +
      status.contextNodes.embeddingPending +
      status.contextNodes.embeddingRunning
    );
  }

  /**
   * Helper: count rows by status field value
   */
  private async countByStatus(
    db: ReturnType<typeof getDb>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table: any,
    statusColumn: string
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    try {
      const rows = await db
        .select({
          status: table[statusColumn],
          count: sql<number>`count(*)`,
        })
        .from(table)
        .groupBy(table[statusColumn])
        .all();

      for (const row of rows) {
        if (row.status) {
          result.set(row.status, row.count);
        }
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), statusColumn },
        "Failed to count by status"
      );
    }

    return result;
  }
}

export const queueInspector = QueueInspector.getInstance();
