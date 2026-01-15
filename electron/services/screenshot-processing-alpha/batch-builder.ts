import crypto from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../../database";
import { batches, screenshots, type NewBatchRecord } from "../../database/schema";
import { getLogger } from "../logger";
import { screenshotProcessingEventBus } from "./event-bus";
import type { AcceptedScreenshot, Batch, SourceKey } from "./types";

const logger = getLogger("batch-builder");

export class BatchBuilder {
  createBatch(sourceKey: SourceKey, screenshots: AcceptedScreenshot[]): Batch {
    if (screenshots.length === 0) {
      throw new Error("Cannot create batch with empty screenshots");
    }

    const sortedScreenshots = [...screenshots].sort((a, b) => a.ts - b.ts);

    const tsStart = sortedScreenshots[0].ts;
    const tsEnd = sortedScreenshots[sortedScreenshots.length - 1].ts;

    const batchId = this.generateBatchId();

    return {
      batchId,
      sourceKey,
      screenshots: sortedScreenshots,
      tsStart,
      tsEnd,
    };
  }

  async createAndPersistBatch(
    sourceKey: SourceKey,
    screenshots: AcceptedScreenshot[]
  ): Promise<{ batch: Batch; dbId: number }> {
    const batch = this.createBatch(sourceKey, screenshots);
    const dbId = await this.persistBatch(batch);

    return { batch, dbId };
  }

  private async persistBatch(batch: Batch): Promise<number> {
    const db = getDb();
    const now = Date.now();
    const screenshotIds = batch.screenshots.map((s) => s.id);

    const dbId = db.transaction((tx) => {
      const record: NewBatchRecord = {
        batchId: batch.batchId,
        sourceKey: batch.sourceKey,
        tsStart: batch.tsStart,
        tsEnd: batch.tsEnd,
        screenshotIds: JSON.stringify(screenshotIds),
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
          .where(eq(batches.batchId, batch.batchId))
          .get();
        if (!existing) {
          throw error;
        }
        batchDbId = existing.id;
      }

      if (screenshotIds.length > 0) {
        const existingEnqueue = tx
          .select({ id: screenshots.id, batchId: screenshots.batchId })
          .from(screenshots)
          .where(inArray(screenshots.id, screenshotIds))
          .all();

        const conflict = existingEnqueue.find((s) => s.batchId != null && s.batchId !== batchDbId);
        if (conflict) {
          throw new Error(
            `Screenshot ${conflict.id} is already assigned to batch ${conflict.batchId}`
          );
        }

        tx.update(screenshots)
          .set({ batchId: batchDbId, updatedAt: now })
          .where(and(inArray(screenshots.id, screenshotIds), isNull(screenshots.batchId)))
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

    screenshotProcessingEventBus.emit("batch:persisted", {
      type: "batch:persisted",
      timestamp: now,
      batchDbId: dbId,
      batchId: batch.batchId,
      sourceKey: batch.sourceKey,
      screenshotIds,
    });

    return dbId;
  }

  private generateBatchId(): string {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `batch_${Date.now()}_${crypto.randomBytes(16).toString("hex")}`;
  }
}

export const batchBuilder = new BatchBuilder();
