/**
 * Screenshot Processing Configuration
 *
 * Centralized configuration for the screenshot processing pipeline.
 */

import os from "node:os";
import path from "node:path";

// ============================================================================
// Source Buffer Configuration
// ============================================================================

/**
 * Source buffer configuration for per-source screenshot buffering
 */
export interface SourceBufferConfig {
  /** Grace period before removing inactive source buffers in milliseconds (default: 60000 = 60s) */
  gracePeriodMs: number;
  /** Refresh interval for active sources in milliseconds (default: 10000 = 10s) */
  refreshIntervalMs: number;
}

export const sourceBufferConfig: SourceBufferConfig = {
  gracePeriodMs: 60000, // 60 seconds grace period for inactive sources
  refreshIntervalMs: 10000, // 10 seconds refresh interval
};

// ============================================================================
// Batch Configuration
// ============================================================================

/**
 * Batch processing configuration
 */
export interface BatchConfig {
  /** Number of screenshots per batch (default: 10) */
  batchSize: number;
  /** Timeout to trigger batch even if not full in milliseconds (default: 70000) */
  batchTimeoutMs: number;
}

export const batchConfig: BatchConfig = {
  batchSize: 10,
  batchTimeoutMs: 70000,
};

// ============================================================================
// VLM Configuration
// ============================================================================

/**
 * VLM processing configuration
 */
export interface VLMConfig {
  /** Number of screenshots per shard (default: 5) */
  vlmShardSize: number;
  /** Number of concurrent shard processing (default: 2) */
  vlmConcurrency: number;
  /** Maximum segments per batch (default: 4) */
  maxSegmentsPerBatch: number;
  /** Maximum derived items per category per segment (default: 2) */
  maxDerivedItemsPerCategory: number;
  /** Maximum summary length in characters (default: 200) */
  maxSummaryLength: number;
  /** Maximum title length in characters (default: 100) */
  maxTitleLength: number;
  /** Maximum entities per batch (default: 20) */
  maxEntitiesPerBatch: number;
}

export const vlmConfig: VLMConfig = {
  vlmShardSize: 5,
  vlmConcurrency: 2,
  maxSegmentsPerBatch: 4,
  maxDerivedItemsPerCategory: 2,
  maxSummaryLength: 200,
  maxTitleLength: 100,
  maxEntitiesPerBatch: 20,
};

// ============================================================================
// pHash Configuration
// ============================================================================

/**
 * pHash deduplication configuration
 */
export interface PHashConfig {
  /** Hamming distance threshold for similarity (default: 8) */
  similarityThreshold: number;
}

export const phashConfig: PHashConfig = {
  similarityThreshold: 8,
};

// ============================================================================
// Retry Configuration
// ============================================================================

/**
 * Retry and recovery configuration
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Backoff schedule in milliseconds (default: [5000, 20000, 60000, 300000]) */
  backoffScheduleMs: number[];
  /** Random jitter to add to backoff in milliseconds (default: 1000) */
  jitterMs: number;
  /** Threshold for considering a running record as stale in milliseconds (default: 300000 = 5min) */
  staleRunningThresholdMs: number;
}

export const retryConfig: RetryConfig = {
  maxAttempts: 3,
  backoffScheduleMs: [5000, 20000, 60000, 300000], // 5s, 20s, 60s, 5min
  jitterMs: 1000,
  staleRunningThresholdMs: 300000, // 5 minutes
};

// ============================================================================
// History Pack Configuration
// ============================================================================

/**
 * History pack configuration for VLM context
 */
export interface HistoryPackConfig {
  /** Number of recent threads to include (default: 3) */
  recentThreadsLimit: number;
  /** Number of recent entities to include (default: 10) */
  recentEntitiesLimit: number;
  /** Time window for open segments in milliseconds (default: 900000 = 15min) */
  openSegmentWindowMs: number;
  /** Maximum characters for summary fields (default: 200) */
  summaryCharLimit: number;
}

export const historyPackConfig: HistoryPackConfig = {
  recentThreadsLimit: 3,
  recentEntitiesLimit: 10,
  openSegmentWindowMs: 900000, // 15 minutes
  summaryCharLimit: 200,
};

// ============================================================================
// Evidence Configuration
// ============================================================================

/**
 * Evidence pack configuration
 */
export interface EvidenceConfig {
  /** Maximum OCR text length in characters (default: 8192) */
  maxOcrTextLength: number;
  /** Maximum UI text snippets to store (default: 20) */
  maxUiTextSnippets: number;
  /** Minimum UI text snippets to store (default: 5) */
  minUiTextSnippets: number;
}

export const evidenceConfig: EvidenceConfig = {
  maxOcrTextLength: 8192,
  maxUiTextSnippets: 20,
  minUiTextSnippets: 5,
};

// ============================================================================
// Reconcile Loop Configuration
// ============================================================================

/**
 * Reconcile loop configuration
 */
export interface ReconcileConfig {
  /** Scan interval in milliseconds (default: 30000 = 30s) */
  scanIntervalMs: number;
  /** Number of records to process per scan (default: 50) */
  batchSize: number;
  /** Threshold for considering a running record as stale in milliseconds (default: 300000 = 5min) */
  staleRunningThresholdMs: number;
  /** Whether to enable the reconcile loop (default: true) */
  enabled: boolean;
}

export const reconcileConfig: ReconcileConfig = {
  scanIntervalMs: 30000,
  batchSize: 50,
  staleRunningThresholdMs: 300000,
  enabled: true,
};

// ============================================================================
// Activity Summary Configuration
// ============================================================================

/**
 * Activity summary generation configuration
 */
export interface ActivitySummaryConfig {
  /** Generation interval in milliseconds (default: 900000 = 15min) */
  generationIntervalMs: number;
  /** Whether to enable automatic generation (default: true) */
  enabled: boolean;
}

export const activitySummaryConfig: ActivitySummaryConfig = {
  generationIntervalMs: 900000, // 15 minutes
  enabled: true,
};

// ============================================================================
// Vector Store Configuration
// ============================================================================

/**
 * Vector store configuration
 */
export interface VectorStoreConfig {
  /** Number of dimensions for embeddings (default: 1536 for text-embedding-3-small) */
  numDimensions: number;
  /** Default top-K for search (default: 10) */
  defaultTopK: number;
  /** Path to store the HNSW index file */
  indexFilePath: string;
}

export const vectorStoreConfig: VectorStoreConfig = {
  numDimensions: 1536,
  defaultTopK: 10,
  indexFilePath: path.join(os.homedir(), ".mnemora", "vector_index.bin"),
};

// ============================================================================
// Combined Configuration
// ============================================================================

/**
 * All configuration combined
 */
export interface ScreenshotProcessingConfig {
  batch: BatchConfig;
  vlm: VLMConfig;
  phash: PHashConfig;
  retry: RetryConfig;
  historyPack: HistoryPackConfig;
  evidence: EvidenceConfig;
  reconcile: ReconcileConfig;
  activitySummary: ActivitySummaryConfig;
  vectorStore: VectorStoreConfig;
}

/**
 * Get the complete configuration
 */
export function getConfig(): ScreenshotProcessingConfig {
  return {
    batch: batchConfig,
    vlm: vlmConfig,
    phash: phashConfig,
    retry: retryConfig,
    historyPack: historyPackConfig,
    evidence: evidenceConfig,
    reconcile: reconcileConfig,
    activitySummary: activitySummaryConfig,
    vectorStore: vectorStoreConfig,
  };
}

/**
 * Default export for convenience
 */
export default getConfig();
