import type { CaptureCompleteEvent, PreferencesChangedEvent } from "../screen-capture/types";

import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../../database";
import { batches, screenshots } from "../../database/schema";
import { getLogger } from "../logger";
import { safeDeleteCaptureFile } from "../screen-capture/capture-storage";
import { screenCaptureEventBus, type ScreenCaptureModuleType } from "../screen-capture";
import { aiRuntimeService } from "../ai-runtime-service";

import { batchBuilder } from "./batch-builder";
import { processingConfig } from "./config";
import type { AcceptedScreenshot, SourceKey } from "./types";
import type { ScreenshotInput } from "./source-buffer-registry";
import { sourceBufferRegistry } from "./source-buffer-registry";
import type { BatchPersistedEvent, BatchReadyEvent } from "./events";
import { screenshotProcessingEventBus } from "./event-bus";
import { batchVlmScheduler } from "./schedulers/batch-vlm-scheduler";
import { ocrScheduler } from "./schedulers/ocr-scheduler";
import { threadScheduler } from "./schedulers/thread-scheduler";
import { activityTimelineScheduler } from "./schedulers/activity-timeline-scheduler";
import { vectorDocumentScheduler } from "./schedulers/vector-document-scheduler";
import { ocrService } from "./ocr-service";
import { threadRuntimeService } from "./thread-runtime-service";

type InitializeArgs = {
  screenCapture: ScreenCaptureModuleType;
};

export class ScreenshotProcessingModule {
  private readonly logger = getLogger("screenshot-processing-module");
  private initialized = false;
  private fallbackCleanupTimer: NodeJS.Timeout | null = null;
  private fallbackCleanupInProgress = false;

  initialize(options: InitializeArgs): void {
    if (this.initialized) {
      this.dispose();
    }

    const screenCapture = options.screenCapture;
    aiRuntimeService.registerCaptureControlCallbacks({
      stop: async () => {
        screenCapture.stop();
      },
      start: async () => {
        await screenCapture.tryInitialize();
      },
      getState: () => screenCapture.getState(),
    });

    sourceBufferRegistry.initialize(this.onPersistAcceptedScreenshot);

    screenCaptureEventBus.on("preferences:changed", this.onPreferencesChanged);
    screenCaptureEventBus.on("capture:complete", this.onCaptureComplete);
    screenshotProcessingEventBus.on("batch:ready", this.onBatchReady);
    screenshotProcessingEventBus.on("batch:persisted", this.onBatchPersisted);

    threadRuntimeService.start();
    batchVlmScheduler.start();
    ocrScheduler.start();
    threadScheduler.start();
    activityTimelineScheduler.start();
    vectorDocumentScheduler.start();
    this.startFallbackCleanup();
    this.initialized = true;
  }

  dispose(): void {
    if (!this.initialized) {
      return;
    }

    screenCaptureEventBus.off("preferences:changed", this.onPreferencesChanged);
    screenCaptureEventBus.off("capture:complete", this.onCaptureComplete);
    screenshotProcessingEventBus.off("batch:ready", this.onBatchReady);
    screenshotProcessingEventBus.off("batch:persisted", this.onBatchPersisted);

    sourceBufferRegistry.dispose();

    batchVlmScheduler.stop();
    ocrScheduler.stop();
    threadScheduler.stop();
    activityTimelineScheduler.stop();
    vectorDocumentScheduler.stop();
    threadRuntimeService.stop();
    this.stopFallbackCleanup();

    this.initialized = false;
  }

  private startFallbackCleanup(): void {
    this.stopFallbackCleanup();
    const intervalMs = processingConfig.cleanup.fallbackIntervalMs;
    this.fallbackCleanupTimer = setInterval(() => {
      void this.fallbackCleanup();
    }, intervalMs);
    void this.fallbackCleanup();
  }

  private stopFallbackCleanup(): void {
    if (this.fallbackCleanupTimer) {
      clearInterval(this.fallbackCleanupTimer);
      this.fallbackCleanupTimer = null;
    }
  }

  private async fallbackCleanup(): Promise<void> {
    if (this.fallbackCleanupInProgress) {
      return;
    }
    this.fallbackCleanupInProgress = true;
    try {
      const db = getDb();
      const now = Date.now();
      const cutoff = now - processingConfig.cleanup.fallbackEphemeralMaxAgeMs;
      const batchSize = processingConfig.cleanup.fallbackBatchSize;

      const candidates = db
        .select({ id: screenshots.id, filePath: screenshots.filePath })
        .from(screenshots)
        .innerJoin(batches, eq(screenshots.batchId, batches.id))
        .where(
          and(
            eq(screenshots.storageState, "ephemeral"),
            lt(screenshots.createdAt, cutoff),
            isNotNull(screenshots.filePath),
            eq(batches.vlmStatus, "succeeded"),
            or(
              isNull(screenshots.ocrStatus),
              inArray(screenshots.ocrStatus, ["succeeded", "failed_permanent"])
            )
          )
        )
        .limit(batchSize)
        .all();

      if (candidates.length === 0) {
        return;
      }

      let deletedCount = 0;
      for (const ss of candidates) {
        const filePath = ss.filePath;
        if (!filePath) {
          continue;
        }
        const ok = await safeDeleteCaptureFile(filePath);
        if (!ok) {
          continue;
        }
        const res = db
          .update(screenshots)
          .set({ storageState: "deleted", updatedAt: now })
          .where(and(eq(screenshots.id, ss.id), eq(screenshots.storageState, "ephemeral")))
          .run();
        if (res.changes > 0) {
          deletedCount += 1;
        }
      }

      if (deletedCount > 0) {
        this.logger.info({ deletedCount }, "Fallback cleanup deleted stale ephemeral screenshots");
      }
    } catch (error) {
      this.logger.error({ error }, "Fallback cleanup failed");
    } finally {
      this.fallbackCleanupInProgress = false;
    }
  }

  async ocrWarmup(): Promise<void> {
    await ocrService.warmup();
  }

  private readonly onPreferencesChanged = async (event: PreferencesChangedEvent) => {
    try {
      sourceBufferRegistry.setPreferences(event.preferences);
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to refresh source buffer registry on preferences change"
      );
    }
  };

  private readonly onPersistAcceptedScreenshot = async (
    accepted: Omit<AcceptedScreenshot, "id">
  ) => {
    const db = getDb();
    const now = Date.now();
    const inserted = db
      .insert(screenshots)
      .values({
        sourceKey: accepted.sourceKey,
        ts: accepted.ts,
        phash: accepted.phash,
        width: accepted.meta.width ?? null,
        height: accepted.meta.height ?? null,
        appHint: accepted.meta.appHint ?? null,
        windowTitle: accepted.meta.windowTitle ?? null,
        filePath: accepted.filePath,
        storageState: "ephemeral",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: screenshots.id })
      .get();

    return inserted.id;
  };

  /**
   * Update the pHash Hamming distance threshold for deduplication.
   * Called by BackpressureMonitor via ScreenCaptureModule.
   */
  setPhashThreshold(threshold: number): void {
    this.logger.info({ threshold }, "Updating pHash threshold in SourceBufferRegistry");
    sourceBufferRegistry.setPhashThreshold?.(threshold);
  }

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

      for (const [sourceKey, screenshotsForSource] of entries) {
        try {
          const { batch } = await batchBuilder.createAndPersistBatch(
            sourceKey,
            screenshotsForSource
          );
          this.logger.info({ batchId: batch.batchId, sourceKey }, "Batch persisted");
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

  private readonly onBatchPersisted = (event: BatchPersistedEvent) => {
    try {
      this.logger.info(
        { batchId: event.batchId, batchDbId: event.batchDbId, sourceKey: event.sourceKey },
        "Waking batch VLM scheduler"
      );
      batchVlmScheduler.wake();
    } catch (error) {
      this.logger.error({ error }, "Failed to wake batch VLM scheduler on batch:persisted");
    }
  };
}

export const screenshotProcessingModule = new ScreenshotProcessingModule();
