/**
 * Screenshot Processing Module
 *
 * Main entry point for the screenshot processing pipeline.
 * Exports all types, schemas, and configuration.
 */

// Export types
export * from "./types";

// Export configuration
export { processingConfig } from "./config";

// Export pHash deduplication
export { computeHash, hammingDistance, isDuplicateByLast } from "./phash-dedup";

export type {
  ActivityTimelineChangedEvent,
  BatchPersistedEvent,
  BatchReadyEvent,
  PipelineBatchFinishedEvent,
  PipelineBatchStartedEvent,
  VectorDocumentsDirtyEvent,
  VectorDocumentTaskFinishedEvent,
} from "./events";
export { screenshotProcessingEventBus } from "./event-bus";

// Export source buffer registry (unified class for source management and buffering)
export {
  SourceBufferRegistry,
  type SourceBuffer,
  type AddResult,
  type ScreenshotInput,
} from "./source-buffer-registry";

// Export batch builder
export { BatchBuilder, batchBuilder } from "./batch-builder";

// Export VLM processor
export { vlmProcessor, VLMParseError } from "./vlm-processor";

// Export Text LLM processor
export {
  TextLLMProcessor,
  textLLMProcessor,
  type ExpandResult,
  type MergeResult,
} from "./text-llm-processor";

// Export screenshot pipeline scheduler
export {
  ScreenshotPipelineScheduler,
  screenshotPipelineScheduler,
} from "./screenshot-pipeline-scheduler";

// Export screenshot processing module (orchestration facade)
export {
  ScreenshotProcessingModule,
  screenshotProcessingModule,
} from "./screenshot-processing-module";

// Export context graph service (public API only)
export {
  ContextGraphService,
  contextGraphService,
  type CreateNodeInput,
  type UpdateNodeInput,
} from "./context-graph-service";

// Re-export GraphTraversalResult from types (unified DTO)
export type { GraphTraversalResult } from "./types";
