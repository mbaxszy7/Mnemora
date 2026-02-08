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

export interface SchedulerEvent {
  scheduler: string;
  timestamp: number;
}

export interface SchedulerLifecycleEvent extends SchedulerEvent {
  reason?: string;
}

export interface SchedulerCycleEndEvent extends SchedulerEvent {
  durationMs: number;
  error?: string;
}

export interface BatchVlmResultEvent {
  batchId: number;
  timestamp: number;
  error?: string;
  attempts?: number;
  permanent?: boolean;
}

export interface ScreenshotOcrResultEvent {
  screenshotId: number;
  timestamp: number;
  error?: string;
  attempts?: number;
  permanent?: boolean;
}

export interface ActivityTimelineChangedEvent {
  type: "activity-timeline:changed";
  timestamp: number;
  payload: {
    revision: number;
    fromTs: number;
    toTs: number;
  };
}

export interface ActivitySummarySucceededEvent {
  type: "activity-summary:succeeded";
  timestamp: number;
  payload: {
    windowStart: number;
    windowEnd: number;
    summaryId: number | null;
    updatedAt: number;
  };
}

export interface ThreadsChangedEvent {
  type: "threads:changed";
  timestamp: number;
  reason: string;
  changedCount: number;
}

export type ScreenshotAcceptEvent = AcceptedScreenshot;

export interface ScreenshotProcessingEventMap {
  "batch:ready": BatchReadyEvent;
  "batch:persisted": BatchPersistedEvent;
  "screenshot-accept": ScreenshotAcceptEvent;

  "vector-documents:dirty": {
    type: "vector-documents:dirty";
    timestamp: number;
    reason: string;
    vectorDocumentId: number;
    nodeId: number;
  };

  // Scheduler Lifecycle
  "scheduler:started": SchedulerLifecycleEvent;
  "scheduler:stopped": SchedulerLifecycleEvent;
  "scheduler:degraded": SchedulerLifecycleEvent;
  "scheduler:waked": SchedulerLifecycleEvent;
  "scheduler:cycle:start": SchedulerEvent;
  "scheduler:cycle:end": SchedulerCycleEndEvent;

  // Data Status
  "batch:vlm:succeeded": BatchVlmResultEvent;
  "batch:vlm:failed": BatchVlmResultEvent;
  "screenshot:ocr:queued": { screenshotIds: number[]; timestamp: number };
  "screenshot:ocr:succeeded": ScreenshotOcrResultEvent;
  "screenshot:ocr:failed": ScreenshotOcrResultEvent;
  "batch:thread:succeeded": { batchId: number; threadId: string; timestamp: number };
  "batch:thread:failed": { batchId: number; error: string; timestamp: number };
  "activity-timeline:changed": ActivityTimelineChangedEvent;
  "activity-summary:succeeded": ActivitySummarySucceededEvent;
  "threads:changed": ThreadsChangedEvent;
}
