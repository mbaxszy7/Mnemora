import os from "node:os";
import path from "node:path";

/**
 * Screenshot Processing Pipeline Configuration
 *
 * This configuration aligns with docs/alpha-implementation-plan.md.
 * Key design principles:
 * - Each screenshot produces exactly one Context Node
 * - Threads replace context_edges for continuity tracking
 * - Hybrid OCR: VLM decides if OCR is needed, local Tesseract.js executes
 *
 * @see docs/alpha-implementation-plan.md for full design documentation
 */
export const processingConfig = {
  /**
   * Batch Trigger Configuration
   *
   * Batches are created when either condition is met:
   * - minSize screenshots accumulated in buffer
   * - timeoutMs elapsed since first screenshot in buffer
   */
  batch: {
    /** Minimum screenshots to trigger batch creation */
    minSize: 2,
    /** Maximum screenshots per batch (for VLM token limits) */
    maxSize: 5,
    /** Timeout to flush buffer even with fewer than minSize screenshots (ms) */
    timeoutMs: 60 * 1000, // 60 seconds
  },

  /**
   * Thread Lifecycle Configuration
   *
   * Threads track user activity continuity across time windows.
   * - Threads can span multiple Activity Summary windows (20 min each)
   * - Long events: threads with duration >= longEventThresholdMs
   * - Gap handling: gaps > gapThresholdMs don't count toward duration
   */
  thread: {
    /** Duration after which inactive thread status changes to 'inactive' (ms) */
    inactiveThresholdMs: 4 * 60 * 60 * 1000, // 4 hours
    /** Gaps longer than this don't count toward thread.duration_ms (ms) */
    gapThresholdMs: 10 * 60 * 1000, // 10 minutes
    /** Threshold for "long event" detection in Activity Monitor (ms) */
    longEventThresholdMs: 25 * 60 * 1000, // 25 minutes
    /** Max active threads to include in Thread LLM prompt */
    maxActiveThreads: 3,
    /** If no active threads, include this many recent threads */
    fallbackRecentThreads: 1,
    /** Recent nodes per thread to include in Thread LLM prompt */
    recentNodesPerThread: 3,
  },

  /**
   * Activity Summary Configuration
   *
   * Activity summaries are generated for fixed time windows.
   * - Checks if context nodes belong to "long event" threads
   * - Long event thread info read from context_nodes.thread_snapshot_json
   *   (not realtime threads table) for data consistency
   */
  activitySummary: {
    /** Fixed window size for activity summaries (ms) */
    windowMs: 20 * 60 * 1000, // 20 minutes
    /** Threshold for long event detection (ms) */
    longEventThresholdMs: 25 * 60 * 1000, // 25 minutes
    summaryConcurrency: 2,
    /** Max context nodes to include in event details evidence */
    eventDetailsEvidenceMaxNodes: 50,
    /** Max characters for event details evidence text */
    eventDetailsEvidenceMaxChars: 24000,
  },

  /**
   * OCR Configuration (Hybrid Strategy)
   *
   * Selective OCR flow:
   * 1. VLM analyzes screenshots, identifies "knowledge" content
   * 2. VLM returns language ("en", "zh", or "other") and text_region
   * 3. Only if language ∈ supportedLanguages, trigger local OCR
   * 4. OCR result stored in screenshots.ocr_text and indexed in screenshots_fts
   *
   * @see docs/alpha-implementation-plan.md "OCR 精准处理流水线"
   */
  ocr: {
    /** Maximum characters to store in screenshots.ocr_text */
    maxChars: 8000,
    /** Tesseract.js language pack (Chinese + English) */
    languages: "eng+chi_sim",
    /** Max parallel OCR workers (keep low to avoid CPU spikes) */
    concurrency: 1,
    /** Only trigger OCR when VLM detects these languages */
    supportedLanguages: ["en", "zh"],
  },

  /**
   * Global Scheduler Configuration
   */
  scheduler: {
    /** Default interval to scan for new work (ms) */
    scanIntervalMs: 30 * 1000, // 30 seconds
    /** Threshold to detect stale "running" tasks for crash recovery (ms) */
    staleRunningThresholdMs: 5 * 60 * 1000, // 5 minutes
    /** Age after which a record is treated as "recovery" lane instead of "realtime" (ms) */
    laneRecoveryAgeMs: 10 * 1000 * 60, // 10 minutes
    scanCap: 100,
    activitySummaryScanCap: 10,
  },

  /**
   * Retry Configuration (All Schedulers)
   */
  retry: {
    /** Maximum retry attempts before marking as failed_permanent */
    maxAttempts: 2,
    /** Delay before retry (ms) */
    delayMs: 60 * 1000, // 1 minute
  },

  cleanup: {
    fallbackEphemeralMaxAgeMs: 24 * 60 * 60 * 1000,
    fallbackBatchSize: 100,
    fallbackIntervalMs: 30 * 60 * 1000,
  },

  /**
   * AI Concurrency Configuration
   *
   * Reuses ai-runtime-service.ts capabilities:
   * - Semaphore: per-capability global concurrency control
   * - Adaptive Concurrency Tuner (AIMD): reduce on failure, increase on success
   * - AI Failure Fuse Breaker: circuit breaker on consecutive failures
   */
  ai: {
    /** Max concurrent VLM requests */
    vlmGlobalConcurrency: 10,
    /** Max concurrent text LLM requests (Thread LLM, Activity LLM, etc.) */
    textGlobalConcurrency: 10,
    /** Max concurrent embedding requests */
    embeddingGlobalConcurrency: 10,

    /** VLM request timeout (ms) */
    vlmTimeoutMs: 120000, // 2 minutes
    /** VLM max output tokens */
    vlmMaxOutputTokens: 8129,
    /** Text LLM request timeout (ms) */
    textTimeoutMs: 120000, // 2 minutes
    /** Embedding request timeout (ms) */
    embeddingTimeoutMs: 60000, // 1 minute

    /** Enable adaptive concurrency tuning (AIMD algorithm) */
    adaptiveEnabled: true,
    /** Minimum concurrency during degradation */
    adaptiveMinConcurrency: 1,
    /** Sliding window size for failure rate calculation */
    adaptiveWindowSize: 20,
    /** Failure rate threshold to trigger degradation (0.0-1.0) */
    adaptiveFailureRateThreshold: 0.2, // 20%
    /** Consecutive failures to trigger immediate degradation */
    adaptiveConsecutiveFailureThreshold: 2,
    /** Cooldown period after degradation before recovery attempt (ms) */
    adaptiveCooldownMs: 30000, // 30 seconds
    /** Concurrency increase step during recovery */
    adaptiveRecoveryStep: 1,
    /** Consecutive successes required before increasing concurrency */
    adaptiveRecoverySuccessThreshold: 20,
  },

  /**
   * Adaptive Backpressure Strategy
   *
   * Controls capture rate based on pending batch count to prevent queue buildup.
   * Core principle: control flow at source (capture), not at processing.
   *
   * Base values from screen-capture/types.ts:
   * - DEFAULT_SCHEDULER_CONFIG.interval = 3000ms (3s)
   * - phash-dedup.ts SimilarityThreshold = 8
   *
   * Levels (matched in order by maxPending):
   * - Level 0 (normal): pending < 4, 3s interval, pHash 8
   * - Level 1 (light):  4-7 pending, 3s interval, pHash 12 (more dedup)
   * - Level 2 (medium): 8-11 pending, 6s interval, pHash 12
   * - Level 3 (heavy):  12+ pending, 12s interval, pHash 12
   *
   * Recovery: stays at lower level for recoveryHysteresisMs before upgrading
   */
  backpressure: {
    levels: [
      {
        /** Max pending batches for this level (exclusive upper bound) */
        maxPending: 3,
        /** Multiplier for DEFAULT_SCHEDULER_CONFIG.interval */
        intervalMultiplier: 1, // 1x = 3s
        /** pHash Hamming distance threshold (higher = more dedup) */
        phashThreshold: 8,
        description: "normal",
      },
      {
        maxPending: 7,
        intervalMultiplier: 1, // 1x = 3s
        phashThreshold: 9, // More aggressive dedup
        description: "light_pressure",
      },
      {
        maxPending: 11,
        intervalMultiplier: 2, // 2x = 6s
        phashThreshold: 10,
        description: "medium_pressure",
      },
      {
        maxPending: Number.POSITIVE_INFINITY,
        intervalMultiplier: 4, // 4x = 12s
        phashThreshold: 11,
        description: "heavy_pressure",
      },
    ],
    /** Observation period before recovering to lower pressure level (ms) */
    recoveryHysteresisMs: 30000, // 30 seconds
    /** Backpressure level change check interval (ms) */
    checkIntervalMs: 5000,
    /** Pending count must stay below threshold for this many cycles */
    recoveryBatchThreshold: 2,
  },

  vectorStore: {
    indexFilePath: path.join(os.homedir(), ".mnemora", "vector_index.bin"),
    flushDebounceMs: 500,
    defaultDimensions: 1024,
  },
};
