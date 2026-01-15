import type { AcceptedScreenshot, SourceKey } from "./types";

export interface BatchReadyEvent {
  type: "batch:ready";
  timestamp: number;
  trigger: "add" | "timeout";
  batches: Record<SourceKey, AcceptedScreenshot[]>;
}

export interface BatchPersistedEvent {
  type: "batch:persisted";
  timestamp: number;
  batchDbId: number;
  batchId: string;
  sourceKey: SourceKey;
  screenshotIds: number[];
}

export type ScreenshotAcceptEvent = AcceptedScreenshot;

export interface ScreenshotProcessingEventMap {
  "batch:ready": BatchReadyEvent;
  "batch:persisted": BatchPersistedEvent;
  "screenshot-accept": ScreenshotAcceptEvent;
}
