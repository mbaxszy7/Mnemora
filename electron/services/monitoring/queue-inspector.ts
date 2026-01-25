import { sql, eq, type SQL } from "drizzle-orm";
import { getDb } from "../../database";
import {
  batches,
  screenshots,
  vectorDocuments,
  activitySummaries,
  activityEvents,
} from "../../database/schema";
import { getLogger } from "../logger";
import type { QueueStatus } from "./monitoring-types";

const logger = getLogger("queue-inspector");

/**
 * QueueInspector
 *
 * Queries database for current queue depths across all pipeline processing queues.
 * Used by MonitoringServer to provide real-time queue status.
 *
 * Queues monitored:
 * - batchesVlm: VLM processing (batches.vlmStatus)
 * - screenshotsOcr: OCR extraction (screenshots.ocrStatus)
 * - batchesThreadLlm: Thread LLM assignment (batches.threadLlmStatus)
 * - vectorDocuments: Embedding + indexing
 * - activitySummaries: Summary generation
 * - activityEventDetails: Event details generation (user-triggered)
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
   * Get current queue status across all pipeline queues
   */
  async getQueueStatus(): Promise<QueueStatus> {
    const ts = Date.now();

    try {
      const db = getDb();

      // Batches VLM status counts
      const batchVlmCounts = await this.countByStatus(db, batches, "vlmStatus");

      // Screenshots OCR status counts
      const screenshotOcrCounts = await this.countByStatus(db, screenshots, "ocrStatus");

      // Batches Thread LLM status counts
      const batchThreadLlmCounts = await this.countByStatus(
        db,
        batches,
        "threadLlmStatus",
        eq(batches.vlmStatus, "succeeded")
      );

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

      // Activity event details status
      const activityEventDetailsCounts = await this.countByStatus(
        db,
        activityEvents,
        "detailsStatus"
      );

      return {
        ts,
        batchesVlm: {
          pending: batchVlmCounts.get("pending") ?? 0,
          running: batchVlmCounts.get("running") ?? 0,
          failed:
            (batchVlmCounts.get("failed") ?? 0) + (batchVlmCounts.get("failed_permanent") ?? 0),
        },
        screenshotsOcr: {
          pending: screenshotOcrCounts.get("pending") ?? 0,
          running: screenshotOcrCounts.get("running") ?? 0,
          failed:
            (screenshotOcrCounts.get("failed") ?? 0) +
            (screenshotOcrCounts.get("failed_permanent") ?? 0),
        },
        batchesThreadLlm: {
          pending: batchThreadLlmCounts.get("pending") ?? 0,
          running: batchThreadLlmCounts.get("running") ?? 0,
          failed:
            (batchThreadLlmCounts.get("failed") ?? 0) +
            (batchThreadLlmCounts.get("failed_permanent") ?? 0),
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
        activityEventDetails: {
          pending: activityEventDetailsCounts.get("pending") ?? 0,
          running: activityEventDetailsCounts.get("running") ?? 0,
          failed:
            (activityEventDetailsCounts.get("failed") ?? 0) +
            (activityEventDetailsCounts.get("failed_permanent") ?? 0),
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
        batchesVlm: { pending: 0, running: 0, failed: 0 },
        screenshotsOcr: { pending: 0, running: 0, failed: 0 },
        batchesThreadLlm: { pending: 0, running: 0, failed: 0 },
        vectorDocuments: {
          embeddingPending: 0,
          embeddingRunning: 0,
          indexPending: 0,
          indexRunning: 0,
          failed: 0,
        },
        activitySummaries: { pending: 0, running: 0, failed: 0 },
        activityEventDetails: { pending: 0, running: 0, failed: 0 },
      };
    }
  }

  /**
   * Get total pending items across all queues (for health indicator)
   * Includes both pending and running items as "active backlog"
   */
  async getTotalPendingCount(): Promise<number> {
    const status = await this.getQueueStatus();
    return this.getTotalPendingCountFromStatus(status);
  }

  getTotalPendingCountFromStatus(status: QueueStatus): number {
    return (
      status.batchesVlm.pending +
      status.batchesVlm.running +
      status.screenshotsOcr.pending +
      status.screenshotsOcr.running +
      status.batchesThreadLlm.pending +
      status.batchesThreadLlm.running +
      status.vectorDocuments.embeddingPending +
      status.vectorDocuments.embeddingRunning +
      status.vectorDocuments.indexPending +
      status.vectorDocuments.indexRunning +
      status.activitySummaries.pending +
      status.activitySummaries.running +
      status.activityEventDetails.pending +
      status.activityEventDetails.running
    );
  }

  /**
   * Helper: count rows by status field value
   */
  private async countByStatus(
    db: ReturnType<typeof getDb>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table: any,
    statusColumn: string,
    where?: SQL
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    try {
      const rows = await (where
        ? db
            .select({
              status: table[statusColumn],
              count: sql<number>`count(*)`,
            })
            .from(table)
            .where(where)
            .groupBy(table[statusColumn])
            .all()
        : db
            .select({
              status: table[statusColumn],
              count: sql<number>`count(*)`,
            })
            .from(table)
            .groupBy(table[statusColumn])
            .all());

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
