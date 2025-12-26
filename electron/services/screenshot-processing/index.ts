/**
 * Screenshot Processing Module
 *
 * Main entry point for the screenshot processing pipeline.
 * Exports all types, schemas, and configuration.
 */

// Export types
export * from "./types";

// Export schemas
export * from "./schemas";

// Export configuration
export {
  getConfig,
  batchConfig,
  vlmConfig,
  phashConfig,
  retryConfig,
  historyPackConfig,
  evidenceConfig,
  reconcileConfig,
  activitySummaryConfig,
  vectorStoreConfig,
  type BatchConfig,
  type VLMConfig,
  type PHashConfig,
  type RetryConfig,
  type HistoryPackConfig,
  type EvidenceConfig,
  type ReconcileConfig,
  type ActivitySummaryConfig,
  type VectorStoreConfig,
  type ScreenshotProcessingConfig,
} from "./config";

// Export pHash deduplication
export { computeHash, hammingDistance, isDuplicateByLast } from "./phash-dedup";

// Export source buffer registry (unified class for source management and buffering)
export {
  SourceBufferRegistry,
  type SourceBuffer,
  type AddResult,
  type ScreenshotInput,
} from "./source-buffer-registry";

// Export source buffer config
export { sourceBufferConfig, type SourceBufferConfig } from "./config";

// Export batch builder
export { BatchBuilder, batchBuilder } from "./batch-builder";

// Export VLM processor
export { runVlmOnBatch, VLMParseError } from "./vlm-processor";

// Export Text LLM processor
export {
  TextLLMProcessor,
  textLLMProcessor,
  expandVLMIndexToNodes,
  type EvidencePack,
  type ExpandResult,
  type MergeResult,
} from "./text-llm-processor";

// Export screenshot processing module (orchestration facade)
export {
  ScreenshotProcessingModule,
  screenshotProcessingModule,
  type ScreenCaptureEventSource,
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
