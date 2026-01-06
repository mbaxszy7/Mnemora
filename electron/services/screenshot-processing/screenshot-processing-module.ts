import type {
  CaptureCompleteEvent,
  SchedulerEvent,
  SchedulerEventHandler,
  SchedulerEventPayload,
} from "../screen-capture/types";

import "./ai-concurrency-tuner";

import type { CapturePreferencesService } from "../capture-preferences-service";
import { getLogger } from "../logger";
import { and, eq, isNotNull, lte } from "drizzle-orm";

import { getDb } from "../../database";
import { screenshots } from "../../database/schema";
import type { SourceKey } from "./types";
import { sourceBufferRegistry, sourceBufferRegistryEmitter } from "./source-buffer-registry";
import type { ScreenshotInput } from "./source-buffer-registry";
import type { BatchReadyEvent } from "./source-buffer-registry";
import { batchBuilder } from "./batch-builder";
import { reconcileLoop } from "./reconcile-loop";
import { activityTimelineScheduler } from "./activity-timeline-scheduler";
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
        try {
          const { batch } = await batchBuilder.createAndPersistBatch(sourceKey, screenshots);
          this.logger.info(
            { batchId: batch.batchId, sourceKey },
            "Batch persisted, waking reconcile loop"
          );
          reconcileLoop.wake();
        } catch (error) {
          this.logger.error(
            { sourceKey, error },
            "Failed to persist batch for source in batch:ready handler"
          );
          continue;
        }
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

    reconcileLoop.start();
    activityTimelineScheduler.start();

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

    sourceBufferRegistry.dispose();

    reconcileLoop.stop();
    activityTimelineScheduler.stop();

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

    this.logger.info("Starting cleanup of expired screenshots");

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

      this.logger.info({ count: candidates.length }, "Expired screenshots cleaned up");
    } catch (error) {
      this.logger.warn({ error }, "Failed to cleanup expired screenshots");
    } finally {
      this.cleanupInProgress = false;
    }
  }
}

export const screenshotProcessingModule = new ScreenshotProcessingModule();
