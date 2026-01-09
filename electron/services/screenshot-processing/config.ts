/**
 * Screenshot Processing Configuration
 *
 * Centralized configuration for the screenshot processing pipeline.
 */

import os from "node:os";
import path from "node:path";

/**
 * Source buffer configuration for per-source screenshot buffering
 */
const sourceBufferConfig = {
  /** Grace period before removing inactive source buffers in milliseconds (default: 60000 = 60s) */
  gracePeriodMs: 60000,
  /** Refresh interval for active sources in milliseconds (default: 10000 = 10s) */
  refreshIntervalMs: 10000,
};

const vlmConfig = {
  /** Number of screenshots per shard (default: 2) */
  vlmShardSize: 2,
  /** Maximum segments per batch (default: 4) */
  maxSegmentsPerBatch: 4,
  /** Maximum entities per batch (default: 20) */
  maxEntitiesPerBatch: 20,
  /** Maximum output tokens for VLM response (default: 8192) */
  maxTokens: 8192,
  evidenceConfig: {
    maxOcrTextLength: 8192,
    maxUiTextSnippets: 20,
  },
};

const historyPackConfig = {
  /** Number of recent threads to include (default: 3) */
  recentThreadsLimit: 3,
  /** Number of recent entities to include (default: 10) */
  recentEntitiesLimit: 10,
  /** Time window for open segments in milliseconds (default: 900000 = 15min) */
  openSegmentWindowMs: 900000, // 15 minutes
  /** Maximum characters for summary fields (default: 200) */
  summaryCharLimit: 200,
};

const batchConfig = {
  /** Number of screenshots per batch (default: 4) */
  batchSize: 4,
  /** Timeout to trigger batch even if not full in milliseconds (default: 70000) */
  batchTimeoutMs: 70000,
  HistoryPack: historyPackConfig,
};

/**
 * AI concurrency and timeout configuration
 *
 * Controls global concurrency limits for AI API calls to prevent
 * overwhelming the provider with too many concurrent requests.
 */
const aiConcurrencyConfig = {
  vlmGlobalConcurrency: 10,
  textGlobalConcurrency: 10,
  embeddingGlobalConcurrency: 10,
  vlmTimeoutMs: 120000, // 2 minutes
  textTimeoutMs: 120000, // 2 minutes
  embeddingTimeoutMs: 60000, // 60 seconds

  adaptiveEnabled: true,
  adaptiveMinConcurrency: 1,
  adaptiveWindowSize: 20,
  adaptiveFailureRateThreshold: 0.2,
  adaptiveConsecutiveFailureThreshold: 2,
  adaptiveCooldownMs: 30000,
  adaptiveRecoveryStep: 1,
  adaptiveRecoverySuccessThreshold: 20,
};

const schedulerConfig = {
  scanIntervalMs: 30000,
  staleRunningThresholdMs: 600000,
  retryConfig: {
    maxAttempts: 5,
    /** Backoff schedule in milliseconds */
    backoffScheduleMs: [10000, 30000, 120000, 300000], // 10s, 30s, 2m, 5m, 10m
    /** Random jitter to add to backoff in milliseconds (default: 5000) */
    jitterMs: 5000,
  },
};

const activitySummaryConfig = {
  generationIntervalMs: 1200000, // 20 minutes
  longEventThresholdMs: 25 * 60 * 1000, // 25 minutes threshold for long events
  eventDetailsEvidenceMaxNodes: 50,
  eventDetailsEvidenceMaxChars: 24000,
};

const vectorStoreConfig = {
  indexFilePath: path.join(os.homedir(), ".mnemora", "vector_index.bin"),
  /** Debounce interval for flushing index to disk (ms) */
  flushDebounceMs: 500,
  defaultDimensions: 1536,
};

export const processingConfig = {
  vlm: vlmConfig,
  captureSource: sourceBufferConfig,
  batch: batchConfig,
  scheduler: schedulerConfig,
  ai: aiConcurrencyConfig,
  activitySummary: activitySummaryConfig,
  vectorStore: vectorStoreConfig,
};
