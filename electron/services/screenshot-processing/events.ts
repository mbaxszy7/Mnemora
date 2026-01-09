import type { ActivityTimelineChangedPayload } from "@shared/activity-types";
import type { AcceptedScreenshot, SourceKey } from "./types";

/**
 * Fired when buffered screenshots are ready to be formed into batches.
 *
 * Meaning:
 * - The buffering stage (SourceBufferRegistry) has decided one or more sources reached a
 *   batch trigger condition, and the buffered screenshots for those sources have been
 *   drained for batch creation.
 *
 * Emitted by:
 * - `SourceBufferRegistry.processReadyBatches()`
 *
 * Typical consumers:
 * - `ScreenshotProcessingModule` (creates/persists batches)
 */
export interface BatchReadyEvent {
  type: "batch:ready";
  /** Event creation timestamp (ms) */
  timestamp: number;
  /** Why the batch became ready */
  trigger: "add" | "timeout";
  /** Drained screenshots grouped by sourceKey */
  batches: Record<SourceKey, AcceptedScreenshot[]>;
}

/**
 * Fired after a batch has been persisted into the database.
 *
 * Meaning:
 * - A durable `batches` DB record exists.
 * - The corresponding screenshots should have been linked/enqueued to this batch in DB.
 *
 * Emitted by:
 * - `BatchBuilder.persistBatch()`
 *
 * Typical consumers:
 * - `ScreenshotProcessingModule` (wake `ScreenshotPipelineScheduler`)
 * - Observability/metrics (batch throughput)
 */
export interface BatchPersistedEvent {
  type: "batch:persisted";
  /** Event creation timestamp (ms) */
  timestamp: number;
  /** Primary key of `batches` table */
  batchDbId: number;
  /** Human-readable unique batch identifier (e.g. batch_...) */
  batchId: string;
  /** Source identifier of the batch */
  sourceKey: SourceKey;
  /** Screenshot DB IDs contained in the batch */
  screenshotIds: number[];
}

/**
 * Fired when the pipeline scheduler successfully *claims* a batch and begins processing.
 *
 * Meaning:
 * - The batch status transitioned to `running` (claim succeeded).
 * - Work will start for VLM + subsequent persistence.
 *
 * Emitted by:
 * - `ScreenshotPipelineScheduler.processBatchRecord()` (immediately after claim succeeds)
 */
export interface PipelineBatchStartedEvent {
  type: "pipeline:batch:started";
  /** Event creation timestamp (ms) */
  timestamp: number;
  /** Primary key of `batches` table */
  batchDbId: number;
  /** Human-readable unique batch identifier */
  batchId: string;
  /** Source identifier of the batch */
  sourceKey: SourceKey;
  /** Attempt counter after claim (starts from 1) */
  attempts: number;
  /** Number of screenshots in this batch */
  screenshotCount: number;
}

/**
 * Fired when pipeline processing for a batch finishes (success or failure).
 *
 * Meaning:
 * - The pipeline has finished handling a batch record for this run.
 * - `status` reflects the terminal result of this run (and in DB it should have been
 *   updated accordingly).
 *
 * Emitted by:
 * - `ScreenshotPipelineScheduler.processBatchRecord()`
 *   - on success: after DB batch status is set to `succeeded`
 *   - on failure: after DB batch status is set to `failed` / `failed_permanent`
 */
export interface PipelineBatchFinishedEvent {
  type: "pipeline:batch:finished";
  /** Event creation timestamp (ms) */
  timestamp: number;
  /** Primary key of `batches` table */
  batchDbId: number;
  /** Human-readable unique batch identifier */
  batchId: string;
  /** Source identifier of the batch */
  sourceKey: SourceKey;
  /** Result status for this run */
  status: "succeeded" | "failed" | "failed_permanent";
  /** Attempt counter for this run */
  attempts: number;
  /** Total processing time for this run (ms) */
  totalMs: number;
  /** VLM stage duration (ms) */
  vlmMs: number;
  /** Text/DB stage duration (ms) */
  textLlmMs: number;
  /** Error message if failed */
  errorMessage?: string;
}

/**
 * Fired when a screenshot is accepted (dedup passed) and assigned a DB id.
 *
 * Meaning:
 * - This represents an individual screenshot acceptance decision.
 * - At this point, the screenshot has a stable `id` (DB PK) and can be referenced by
 *   downstream services.
 *
 * Emitted by:
 * - `SourceBufferRegistry.add()` (after persisting accepted screenshot id, before batching)
 */
export type ScreenshotAcceptEvent = AcceptedScreenshot;

/**
 * Fired when a `vector_documents` record is marked as dirty (needs embedding/index work).
 *
 * Meaning:
 * - The upsert/idempotency layer has decided that the canonical text for a context node
 *   changed (or a new vector document was created), so embedding/index subtasks should be
 *   scheduled.
 *
 * Emitted by:
 * - `VectorDocumentService.upsertForContextNode()` (after resetting statuses to pending)
 *
 * Typical consumers:
 * - `VectorDocumentScheduler` (wake to scan/claim tasks sooner)
 */
export interface VectorDocumentsDirtyEvent {
  type: "vector-documents:dirty";
  /** Event creation timestamp (ms) */
  timestamp: number;
  /** Reason string describing what caused the doc to become dirty */
  reason: string;
  /** Primary key of `vector_documents` table (if known) */
  vectorDocumentId?: number;
  /** Associated context node id (if known) */
  nodeId?: number;
}

/**
 * Fired when a vector-document background task finishes.
 *
 * Meaning:
 * - One subtask in the `vector_documents` state machine has completed for a single record.
 * - Useful for UI progress, metrics, or triggering higher-level workflows.
 *
 * Emitted by:
 * - `VectorDocumentScheduler.processVectorDocumentEmbeddingRecord()`
 * - `VectorDocumentScheduler.processVectorDocumentIndexRecord()`
 */
export interface VectorDocumentTaskFinishedEvent {
  type: "vector-document:task:finished";
  /** Event creation timestamp (ms) */
  timestamp: number;
  /** Which vector subtask finished */
  subtask: "embedding" | "index";
  /** Primary key of `vector_documents` table */
  docId: number;
  /** Result status for this run */
  status: "succeeded" | "failed" | "failed_permanent";
  /** Attempt counter for this subtask run */
  attempts: number;
  /** Error message if failed */
  errorMessage?: string;
}

/**
 * Fired when Activity Timeline data is changed (debounced).
 *
 * Meaning:
 * - Activity timeline windows/events/summaries have been updated for a time range, and
 *   consumers may want to refresh caches or update UI.
 *
 * Emitted by:
 * - `ActivityMonitorService.emitActivityTimelineChanged()` (same debounce as IPC)
 */
export interface ActivityTimelineChangedEvent {
  type: "activity-timeline:changed";
  /** Event creation timestamp (ms) */
  timestamp: number;
  /** The same payload sent through IPC to renderer */
  payload: ActivityTimelineChangedPayload;
}

export interface ScreenshotProcessingEventMap {
  "batch:ready": BatchReadyEvent;
  "batch:persisted": BatchPersistedEvent;
  "pipeline:batch:started": PipelineBatchStartedEvent;
  "pipeline:batch:finished": PipelineBatchFinishedEvent;
  "screenshot-accept": ScreenshotAcceptEvent;
  "vector-documents:dirty": VectorDocumentsDirtyEvent;
  "vector-document:task:finished": VectorDocumentTaskFinishedEvent;
  "activity-timeline:changed": ActivityTimelineChangedEvent;
}
