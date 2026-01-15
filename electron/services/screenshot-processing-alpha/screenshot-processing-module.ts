import type { CaptureCompleteEvent, PreferencesChangedEvent } from "../screen-capture/types";

import { getDb } from "../../database";
import { screenshots } from "../../database/schema";
import { getLogger } from "../logger";
import { safeDeleteCaptureFile } from "../screen-capture/capture-storage";
import { screenCaptureEventBus, type ScreenCaptureModuleType } from "../screen-capture";
import { aiRuntimeService } from "../ai-runtime-service";

import { batchBuilder } from "./batch-builder";
import type { AcceptedScreenshot, SourceKey } from "./types";
import type { ScreenshotInput } from "./source-buffer-registry";
import { sourceBufferRegistry } from "./source-buffer-registry";
import type { BatchPersistedEvent, BatchReadyEvent } from "./events";
import { screenshotProcessingEventBus } from "./event-bus";
import { screenshotPipelineScheduler } from "./screenshot-pipeline-scheduler";
import { activityTimelineScheduler } from "./activity-timeline-scheduler";
import { vectorDocumentScheduler } from "./vector-document-scheduler";

type InitializeArgs = {
  screenCapture: ScreenCaptureModuleType;
};

export class ScreenshotProcessingModule {
  private readonly logger = getLogger("screenshot-processing-module");
  private initialized = false;

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

    screenshotPipelineScheduler.start();
    activityTimelineScheduler.start();
    vectorDocumentScheduler.start();
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

    screenshotPipelineScheduler.stop();
    activityTimelineScheduler.stop();
    vectorDocumentScheduler.stop();

    this.initialized = false;
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
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: screenshots.id })
      .get();

    return inserted.id;
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
        "Waking screenshot pipeline scheduler"
      );
      screenshotPipelineScheduler.wake();
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to wake screenshot pipeline scheduler on batch:persisted"
      );
    }
  };
}

export const screenshotProcessingModule = new ScreenshotProcessingModule();
