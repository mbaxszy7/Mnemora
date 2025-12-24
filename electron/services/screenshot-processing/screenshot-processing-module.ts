import type {
  CaptureCompleteEvent,
  SchedulerEvent,
  SchedulerEventHandler,
  SchedulerEventPayload,
} from "../screen-capture/types";

import type { CapturePreferencesService } from "../capture-preferences-service";
import { getLogger } from "../logger";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";

import { getDb } from "../../database";
import { batches, screenshots } from "../../database/schema";
import type { Batch, Shard, SourceKey } from "./types";
import { sourceBufferRegistry, sourceBufferRegistryEmitter } from "./source-buffer-registry";
import type { ScreenshotInput } from "./source-buffer-registry";
import type { BatchReadyEvent } from "./source-buffer-registry";
import { batchBuilder } from "./batch-builder";
import { runVlmOnBatch } from "./vlm-processor";
import { safeDeleteCaptureFile } from "../screen-capture/capture-storage";

export interface ScreenCaptureEventSource {
  on<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void;
  off<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void;
}

export class ScreenshotProcessingModule {
  private readonly logger = getLogger("screenshot-processing-module");
  private initialized = false;

  private cleanupInterval: NodeJS.Timeout | null = null;
  private cleanupInProgress = false;

  private screenCapture: ScreenCaptureEventSource | null = null;

  private readonly onPreferencesChanged = async () => {
    try {
      await sourceBufferRegistry.refresh();
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to refresh source buffer registry on preferences change"
      );
    }
  };

  private readonly onCaptureComplete = async (event: CaptureCompleteEvent) => {
    try {
      for (const result of event.result) {
        const filePath = result.filePath;
        if (!filePath) {
          continue;
        }

        const sourceKey: SourceKey =
          result.source.type === "screen"
            ? (`screen:${result.source.displayId ?? result.source.id}` as SourceKey)
            : (`window:${result.source.id}` as SourceKey);

        const input: ScreenshotInput = {
          sourceKey,
          imageBuffer: result.buffer,
          screenshot: {
            ts: result.timestamp,
            sourceKey,
            filePath,
            meta: {
              appHint: result.source.appName,
              windowTitle: result.source.windowTitle,
            },
          },
          persistAcceptedScreenshot: async (accepted) => {
            const db = getDb();
            const now = Date.now();
            const inserted = db
              .insert(screenshots)
              .values({
                sourceKey: accepted.sourceKey,
                ts: accepted.ts,
                filePath: accepted.filePath,
                storageState: "ephemeral",
                retentionExpiresAt: null,
                phash: accepted.phash,
                width: accepted.meta.width ?? null,
                height: accepted.meta.height ?? null,
                bytes: accepted.meta.bytes ?? null,
                mime: accepted.meta.mime ?? null,
                appHint: accepted.meta.appHint ?? null,
                windowTitle: accepted.meta.windowTitle ?? null,
                ocrText: null,
                uiTextSnippets: null,
                detectedEntities: null,
                vlmIndexFragment: null,
                vlmStatus: "pending",
                vlmAttempts: 0,
                vlmNextRunAt: null,
                vlmErrorCode: null,
                vlmErrorMessage: null,
                createdAt: now,
                updatedAt: now,
              })
              .returning({ id: screenshots.id })
              .get();

            return inserted.id;
          },
        };

        const addResult = await sourceBufferRegistry.add(input);
        if (!addResult.accepted) {
          await safeDeleteCaptureFile(filePath);
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to route capture results into SourceBufferRegistry");
    }
  };

  private readonly onBatchReady = async (event: BatchReadyEvent) => {
    try {
      const entries = Object.entries(event.batches) as Array<
        [SourceKey, BatchReadyEvent["batches"][SourceKey]]
      >;

      for (const [sourceKey, screenshots] of entries) {
        const { batch } = await batchBuilder.createAndPersistBatch(sourceKey, screenshots);
        const shards = batchBuilder.splitIntoShards(batch);

        await this.dispatchToVlmProcessor(batch, shards);
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to handle batch:ready event");
    }
  };

  initialize(options: {
    screenCapture: ScreenCaptureEventSource;
    preferencesService: CapturePreferencesService;
  }): void {
    if (this.initialized) {
      this.dispose();
    }

    this.screenCapture = options.screenCapture;

    sourceBufferRegistry.initialize(options.preferencesService);

    this.screenCapture.on("preferences:changed", this.onPreferencesChanged);
    this.screenCapture.on<CaptureCompleteEvent>("capture:complete", this.onCaptureComplete);

    sourceBufferRegistryEmitter.on("batch:ready", this.onBatchReady);

    this.startCleanupLoop();

    this.initialized = true;
  }

  dispose(): void {
    if (!this.initialized) {
      return;
    }

    this.screenCapture?.off("preferences:changed", this.onPreferencesChanged);
    this.screenCapture?.off<CaptureCompleteEvent>("capture:complete", this.onCaptureComplete);
    sourceBufferRegistryEmitter.off("batch:ready", this.onBatchReady);

    this.stopCleanupLoop();

    this.screenCapture = null;
    this.initialized = false;
  }

  private startCleanupLoop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const intervalMs = 10 * 60 * 1000;

    this.cleanupInterval = setInterval(() => {
      void this.cleanupExpiredScreenshots();
    }, intervalMs);

    void this.cleanupExpiredScreenshots();
  }

  private stopCleanupLoop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private async cleanupExpiredScreenshots(): Promise<void> {
    if (this.cleanupInProgress) {
      return;
    }

    this.cleanupInProgress = true;
    const db = getDb();
    const now = Date.now();

    try {
      const candidates = db
        .select({ id: screenshots.id, filePath: screenshots.filePath })
        .from(screenshots)
        .where(
          and(
            eq(screenshots.vlmStatus, "succeeded"),
            eq(screenshots.storageState, "ephemeral"),
            isNotNull(screenshots.retentionExpiresAt),
            lte(screenshots.retentionExpiresAt, now),
            isNotNull(screenshots.filePath)
          )
        )
        .all();

      for (const row of candidates) {
        const filePath = row.filePath;
        if (!filePath) {
          continue;
        }

        const deleted = await safeDeleteCaptureFile(filePath);
        if (!deleted) {
          continue;
        }

        db.update(screenshots)
          .set({ storageState: "deleted", filePath: null, updatedAt: Date.now() })
          .where(eq(screenshots.id, row.id))
          .run();
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to cleanup expired screenshots");
    } finally {
      this.cleanupInProgress = false;
    }
  }

  private async dispatchToVlmProcessor(batch: Batch, shards: Shard[]): Promise<void> {
    this.logger.info(
      { batchId: batch.batchId, sourceKey: batch.sourceKey, shardCount: shards.length },
      "Batch ready for VLM processing"
    );

    // TODO: instantiate/use VLMProcessor and hand off shards for processing
    // TODO: handle concurrency, retries, and updating batch status
    // TODO: pass along historyPack (batch.historyPack) and ensure base64 is populated before request

    const db = getDb();
    const screenshotIds = batch.screenshots.map((s) => s.id);

    try {
      const now = Date.now();

      try {
        db.update(batches)
          .set({ status: "running", updatedAt: now, errorMessage: null, errorCode: null })
          .where(eq(batches.batchId, batch.batchId))
          .run();
      } catch (error) {
        this.logger.warn({ batchId: batch.batchId, error }, "Failed to mark batch as running");
      }

      try {
        db.update(screenshots)
          .set({ vlmStatus: "running", updatedAt: now })
          .where(inArray(screenshots.id, screenshotIds))
          .run();
      } catch (error) {
        this.logger.warn(
          { batchId: batch.batchId, error },
          "Failed to mark screenshots as running"
        );
      }

      const index = await runVlmOnBatch(batch, shards);
      const updatedAt = Date.now();

      const retentionTtlMs = 1 * 60 * 60 * 1000;
      const retentionExpiresAt = Date.now() + retentionTtlMs;

      try {
        db.update(screenshots)
          .set({ vlmStatus: "succeeded", retentionExpiresAt, updatedAt })
          .where(inArray(screenshots.id, screenshotIds))
          .run();
      } catch (error) {
        this.logger.warn(
          { batchId: batch.batchId, error },
          "Failed to mark screenshots as succeeded / set retention"
        );
      }

      db.update(batches)
        .set({ status: "succeeded", indexJson: JSON.stringify(index), updatedAt })
        .where(eq(batches.batchId, batch.batchId))
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updatedAt = Date.now();

      try {
        db.update(batches)
          .set({ status: "failed", errorMessage: message, updatedAt })
          .where(eq(batches.batchId, batch.batchId))
          .run();
      } catch (dbError) {
        this.logger.error(
          { batchId: batch.batchId, error: dbError },
          "Failed to persist batch failure"
        );
      }

      try {
        db.update(screenshots)
          .set({ vlmStatus: "failed", updatedAt })
          .where(inArray(screenshots.id, screenshotIds))
          .run();
      } catch (dbError) {
        this.logger.warn(
          { batchId: batch.batchId, error: dbError },
          "Failed to mark screenshots as failed"
        );
      }

      this.logger.error({ batchId: batch.batchId, error }, "VLM processing failed");
    }
  }
}

export const screenshotProcessingModule = new ScreenshotProcessingModule();
