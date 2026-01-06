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
interface SourceBufferConfig {
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
interface BatchConfig {
  /** Number of screenshots per batch (default: 10) */
  batchSize: number;
  /** Timeout to trigger batch even if not full in milliseconds (default: 70000) */
  batchTimeoutMs: number;
}

export const batchConfig: BatchConfig = {
  batchSize: 4,
  batchTimeoutMs: 70000,
};

// ============================================================================
// VLM Configuration
// ============================================================================

/**
 * VLM processing configuration
 */
interface VLMConfig {
  /** Number of screenshots per shard (default: 5) */
  vlmShardSize: number;
  /** Maximum segments per batch (default: 4) */
  maxSegmentsPerBatch: number;
  /** Maximum entities per batch (default: 20) */
  maxEntitiesPerBatch: number;
  /** Maximum output tokens for VLM response (default: 8192) */
  maxTokens: number;
}

export const vlmConfig: VLMConfig = {
  vlmShardSize: 2,
  maxSegmentsPerBatch: 4,
  maxEntitiesPerBatch: 20,
  maxTokens: 8192,
};

// ============================================================================
// pHash Configuration
// ============================================================================

/**
 * pHash deduplication configuration
 */
interface PHashConfig {
  /** Hamming distance threshold for similarity (default: 8) */
  similarityThreshold: number;
}

export const phashConfig: PHashConfig = {
  similarityThreshold: 8,
};

// ============================================================================
// AI Concurrency Configuration
// ============================================================================

/**
 * AI concurrency and timeout configuration
 *
 * Controls global concurrency limits for AI API calls to prevent
 * overwhelming the provider with too many concurrent requests.
 */
interface AIConcurrencyConfig {
  /** Maximum concurrent VLM API calls (default: 2) */
  vlmGlobalConcurrency: number;
  /** Maximum concurrent Text LLM API calls (default: 3) */
  textGlobalConcurrency: number;
  /** Maximum concurrent Embedding API calls (default: 5) */
  embeddingGlobalConcurrency: number;
  /** VLM request timeout in milliseconds (default: 120000 = 2min) */
  vlmTimeoutMs: number;
  /** Text LLM request timeout in milliseconds (default: 120000 = 2min) */
  textTimeoutMs: number;
  /** Embedding request timeout in milliseconds (default: 30000 = 30s) */
  embeddingTimeoutMs: number;

  adaptiveEnabled: boolean;
  adaptiveMinConcurrency: number;
  adaptiveWindowSize: number;
  adaptiveFailureRateThreshold: number;
  adaptiveConsecutiveFailureThreshold: number;
  adaptiveCooldownMs: number;
  adaptiveRecoveryStep: number;
  adaptiveRecoverySuccessThreshold: number;
}

export const aiConcurrencyConfig: AIConcurrencyConfig = {
  vlmGlobalConcurrency: 10,
  textGlobalConcurrency: 10,
  embeddingGlobalConcurrency: 10,
  vlmTimeoutMs: 120000, // 2 minutes
  textTimeoutMs: 120000, // 2 minutes
  embeddingTimeoutMs: 30000, // 30 seconds

  adaptiveEnabled: true,
  adaptiveMinConcurrency: 1,
  adaptiveWindowSize: 20,
  adaptiveFailureRateThreshold: 0.2,
  adaptiveConsecutiveFailureThreshold: 2,
  adaptiveCooldownMs: 30000,
  adaptiveRecoveryStep: 1,
  adaptiveRecoverySuccessThreshold: 20,
};

// ============================================================================
// Retry Configuration
// ============================================================================

/**
 * Retry and recovery configuration
 */
interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Backoff schedule in milliseconds (default: [5000, 20000, 60000, 300000]) */
  backoffScheduleMs: number[];
  /** Random jitter to add to backoff in milliseconds (default: 5000) */
  jitterMs: number;
}

export const retryConfig: RetryConfig = {
  maxAttempts: 5,
  backoffScheduleMs: [10000, 30000, 120000, 300000, 600000], // 10s, 30s, 2m, 5m, 10m
  jitterMs: 5000,
};

// ============================================================================
// History Pack Configuration
// ============================================================================

/**
 * History pack configuration for VLM context
 */
interface HistoryPackConfig {
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
interface EvidenceConfig {
  /** Maximum OCR text length in characters (default: 8192) */
  maxOcrTextLength: number;
  /** Maximum UI text snippets to store (default: 20) */
  maxUiTextSnippets: number;
}

export const evidenceConfig: EvidenceConfig = {
  maxOcrTextLength: 8192,
  maxUiTextSnippets: 20,
};

// ============================================================================
// Reconcile Loop Configuration
// ============================================================================

/**
 * Reconcile loop configuration
 */
interface ReconcileConfig {
  /** Scan interval in milliseconds (default: 30000 = 30s) */
  scanIntervalMs: number;
  /** Threshold for considering a running record as stale in milliseconds (default: 300000 = 5min) */
  staleRunningThresholdMs: number;
  /** Whether to enable the reconcile loop (default: true) */
  enabled: boolean;
}

export const reconcileConfig: ReconcileConfig = {
  scanIntervalMs: 30000,
  staleRunningThresholdMs: 600000,
  enabled: true,
};

const processingConfigInternal = {
  batch: batchConfig,
  reconcile: reconcileConfig,
  ai: aiConcurrencyConfig,
};

export const processingConfig = processingConfigInternal;

// ============================================================================
// Activity Summary Configuration
// ============================================================================

/**
 * Activity summary generation configuration
 */
interface ActivitySummaryConfig {
  /** Generation interval in milliseconds (default: 1200000 = 20min) */
  generationIntervalMs: number;
  /** Whether to enable automatic generation (default: true) */
  enabled: boolean;
}

export const activitySummaryConfig: ActivitySummaryConfig = {
  generationIntervalMs: 1200000, // 20 minutes
  enabled: true,
};

// ============================================================================
// Vector Store Configuration
// ============================================================================

/**
 * Vector store configuration
 */
interface VectorStoreConfig {
  /** Path to store the HNSW index file */
  indexFilePath: string;
  /** Debounce interval for flushing index to disk (ms) */
  flushDebounceMs?: number;
}

export const vectorStoreConfig: VectorStoreConfig = {
  indexFilePath: path.join(os.homedir(), ".mnemora", "vector_index.bin"),
  flushDebounceMs: 500,
};
