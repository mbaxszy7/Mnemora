/**
 * VLM Processor
 *
 * Responsible for:
 * - Building VLM requests from shards with screenshot metadata
 * - Processing shards through VLM with parallel execution
 * - Parsing and validating VLM responses using Zod schemas
 * - Merging shard results while preserving time order
 * - Repairing malformed JSON responses
 * - Updating screenshot vlm_status on success
 *
 */

import fs from "node:fs/promises";
import { generateObject, NoObjectGeneratedError } from "ai";
import { inArray } from "drizzle-orm";

import { getDb } from "../../database";
import { screenshots } from "../../database/schema";
import { AISDKService } from "../ai-sdk-service";
import { getLogger } from "../logger";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "../screen-capture/types";
import { processingConfig } from "./config";
import { promptTemplates } from "./prompt-templates";
import {
  VLMIndexResultSchema,
  VLMIndexResultProcessedSchema,
  type VLMIndexResult,
  type VLMSegment,
  type VLMScreenshotMeta,
} from "./schemas";
import type { Shard, HistoryPack, Batch, ScreenshotWithData } from "./types";
import { llmUsageService } from "../llm-usage-service";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { aiRuntimeService } from "../ai-runtime-service";

const logger = getLogger("vlm-processor");

function getCanonicalAppCandidates(): string[] {
  return Object.keys(DEFAULT_WINDOW_FILTER_CONFIG.appAliases);
}

// ============================================================================
// Types
// ============================================================================

/**
 * VLM request structure for AI SDK
 */
interface VLMRequest {
  system: string;
  userContent: Array<{ type: "text"; text: string } | { type: "image"; image: string }>;
}

/**
 * Result of processing a single shard
 */
interface ShardProcessResult {
  shardIndex: number;
  success: boolean;
  result?: VLMIndexResult;
  error?: Error;
}

/**
 * Result of processing an entire batch
 */
interface BatchProcessResult {
  batchId: string;
  success: boolean;
  mergedResult?: VLMIndexResult;
  shardResults: ShardProcessResult[];
  error?: string;
}

// ============================================================================
// VLM System Prompt
// ============================================================================

// ============================================================================
// VLMProcessor Class
// ============================================================================

/**
 * VLMProcessor handles VLM-based screenshot analysis
 */
class VLMProcessor {
  private readonly maxSegmentsPerBatch = processingConfig.vlm.maxSegmentsPerBatch;

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build VLM request from a shard
   *
   *
   *
   * @param shard - Shard with screenshots and history pack
   * @returns VLM request ready for AI SDK
   */
  buildVLMRequest(shard: Shard, options?: { degraded?: boolean }): VLMRequest {
    const screenshotMeta = this.buildScreenshotMeta(shard.screenshots);
    const userPrompt = this.buildUserPrompt(screenshotMeta, shard.historyPack, options);

    const userContent: VLMRequest["userContent"] = [{ type: "text", text: userPrompt }];

    // Add images
    for (const screenshot of shard.screenshots) {
      logger.info(
        {
          screenshotId: screenshot.id,
          base64: !!screenshot.base64,
          meta: screenshot.meta,
        },
        "Adding screenshot to VLM request"
      );
      if (screenshot.base64) {
        const mime = screenshot.meta.mime || "image/jpeg";
        userContent.push({
          type: "image",
          image: `data:${mime};base64,${screenshot.base64}`,
        });
      }
    }

    return {
      system: promptTemplates.getVLMSystemPrompt(),
      userContent,
    };
  }

  /**
   * Process a single shard through VLM
   *
   * @param shard - Shard to process (must have base64 data loaded)
   * @returns VLM index result
   */
  async processShard(shard: Shard): Promise<VLMIndexResult> {
    const processStartTime = Date.now();
    const timings: Record<string, number> = {};

    const aiService = AISDKService.getInstance();

    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    // Build request with timing
    const buildRequestStart = Date.now();
    const request = this.buildVLMRequest(shard);
    timings.buildRequest = Date.now() - buildRequestStart;

    logger.debug(
      {
        shardIndex: shard.shardIndex,
        screenshotCount: shard.screenshots.length,
        buildRequestMs: timings.buildRequest,
      },
      "VLM request built, calling API"
    );

    // Acquire global VLM semaphore
    const release = await aiRuntimeService.acquire("vlm");

    const runAttempt = async (degraded: boolean) => {
      const attemptStart = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.vlmTimeoutMs);
      try {
        const req = degraded ? this.buildVLMRequest(shard, { degraded: true }) : request;
        const { object: rawResult, usage } = await generateObject({
          model: aiService.getVLMClient(),
          schema: VLMIndexResultSchema,
          system: req.system,
          messages: [
            {
              role: "user",
              content: req.userContent,
            },
          ],
          providerOptions: {
            mnemora: {
              thinking: {
                type: "disabled",
              },
            },
          },
          maxOutputTokens: processingConfig.vlm.maxTokens,
          abortSignal: controller.signal,
        });

        const result = VLMIndexResultProcessedSchema.parse(rawResult);
        return {
          result,
          usage,
          attemptMs: Date.now() - attemptStart,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      // Call VLM with timing
      const apiCallStart = Date.now();
      const response = await runAttempt(false);
      timings.apiCall = Date.now() - apiCallStart;

      return this.finalizeShardSuccess({
        shard,
        result: response.result,
        timings,
        usage: response.usage,
        processStartTime,
        aiService,
      });
    } catch (error) {
      const isRetryable =
        (error instanceof Error && error.name === "AbortError") ||
        NoObjectGeneratedError.isInstance(error);

      if (isRetryable) {
        try {
          const apiCallStart = Date.now();
          const response = await runAttempt(true);
          timings.apiCall = Date.now() - apiCallStart;

          return this.finalizeShardSuccess({
            shard,
            timings,
            result: response.result,
            usage: response.usage,
            processStartTime,
            aiService,
          });
        } catch (secondError) {
          this.finalizeShardFailure({
            shard,
            timings,
            processStartTime,
            aiService,
            error: secondError,
          });
          throw secondError;
        }
      }

      this.finalizeShardFailure({
        shard,
        timings,
        processStartTime,
        aiService,
        error,
      });
      throw error;
    } finally {
      release();
    }
  }

  private finalizeShardSuccess(args: {
    shard: Shard;
    result: VLMIndexResult;
    timings: Record<string, number>;
    usage: { totalTokens?: number } | undefined;
    processStartTime: number;
    aiService: AISDKService;
  }): VLMIndexResult {
    const { shard, result, timings, usage, processStartTime, aiService } = args;

    aiRuntimeService.recordSuccess("vlm");

    logger.debug(
      {
        shardIndex: shard.shardIndex,
        apiCallMs: timings.apiCall,
      },
      "VLM API responded with structured object"
    );

    // Log usage
    llmUsageService.logEvent({
      ts: Date.now(),
      capability: "vlm",
      operation: "vlm_analyze_shard",
      status: "succeeded",
      model: aiService.getVLMModelName(),
      provider: "openai_compatible",
      totalTokens: usage?.totalTokens ?? 0,
      usageStatus: usage ? "present" : "missing",
    });

    const totalMs = Date.now() - processStartTime;

    // Record trace for monitoring dashboard
    aiRequestTraceBuffer.record({
      ts: Date.now(),
      capability: "vlm",
      operation: "vlm_analyze_shard",
      model: aiService.getVLMModelName(),
      durationMs: totalMs,
      status: "succeeded",
      responsePreview: JSON.stringify(result, null, 2),
      images: shard.screenshots
        .filter((s) => s.base64)
        .map((s) => `data:${s.meta.mime || "image/jpeg"};base64,${s.base64}`),
    });

    logger.info(
      {
        shardIndex: shard.shardIndex,
        totalMs,
        timings,
        segmentCount: result.segments.length,
        entityCount: result.entities.length,
      },
      "Shard processed successfully"
    );

    return result;
  }

  private finalizeShardFailure(args: {
    shard: Shard;
    timings: Record<string, number>;
    processStartTime: number;
    aiService: AISDKService;
    error: unknown;
  }): void {
    const { shard, timings, processStartTime, aiService, error } = args;
    const totalMs = Date.now() - processStartTime;

    aiRuntimeService.recordFailure("vlm", error);

    // Log failure usage (unknown tokens)
    llmUsageService.logEvent({
      ts: Date.now(),
      capability: "vlm",
      operation: "vlm_analyze_shard",
      status: "failed",
      errorCode: error instanceof Error ? error.name : "UNKNOWN",
      model: aiService.getVLMModelName(),
      provider: "openai_compatible",
      usageStatus: "missing",
    });

    // Record trace for monitoring dashboard
    aiRequestTraceBuffer.record({
      ts: Date.now(),
      capability: "vlm",
      operation: "vlm_analyze_shard",
      model: aiService.getVLMModelName(),
      durationMs: totalMs,
      status: "failed",
      errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      images: shard.screenshots
        .filter((s) => s.base64)
        .map((s) => `data:${s.meta.mime || "image/jpeg"};base64,${s.base64}`),
    });

    logger.error(
      {
        shardIndex: shard.shardIndex,
        totalMs,
        timings,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to process shard"
    );

    if (NoObjectGeneratedError.isInstance(error)) {
      logger.error(
        {
          cause: error.cause,
          text: error.text,
          response: error.response,
          usage: error.usage,
          finishReason: error.finishReason,
        },
        "NoObjectGeneratedError"
      );
    }

    // Record failure for circuit breaker
    // (Included in aiRuntimeService.recordFailure)
  }

  /**
   * Process all shards of a batch in parallel
   *
   * @param batch - Batch to process
   * @param shards - Shards to process (must have base64 data loaded)
   * @returns Batch processing result with merged VLM index
   */
  async processBatch(batch: Batch, shards: Shard[]): Promise<BatchProcessResult> {
    logger.info(
      {
        batchId: batch.batchId,
        shardCount: shards.length,
        globalConcurrency: processingConfig.ai.vlmGlobalConcurrency,
      },
      "Processing batch"
    );

    // Process shards with concurrency limit
    const shardResults = await this.processShardsConcurrently(shards);

    // Check if all shards succeeded
    const allSucceeded = shardResults.every((r) => r.success);

    if (!allSucceeded) {
      const failedShards = shardResults.filter((r) => !r.success);
      logger.error(
        {
          batchId: batch.batchId,
          failedCount: failedShards.length,
          errors: failedShards.map((r) => r.error?.name),
        },
        "Some shards failed"
      );

      await this.updateScreenshotStatuses(batch, "failed");

      return {
        batchId: batch.batchId,
        success: false,
        shardResults,
        error: `${failedShards.length} shard(s) failed`,
      };
    }

    // Merge results
    const successfulResults = shardResults
      .filter((r) => r.success && r.result)
      .map((r) => r.result!);

    const mergedResult = this.mergeShardResults(successfulResults);

    await this.updateScreenshotStatuses(batch, "succeeded");

    logger.info(
      {
        batchId: batch.batchId,
        segmentCount: mergedResult.segments.length,
        entityCount: mergedResult.entities.length,
      },
      "Successfully processed batch"
    );

    return {
      batchId: batch.batchId,
      success: true,
      mergedResult,
      shardResults,
    };
  }

  /**
   * Merge results from multiple shards
   *
   * - Maintains time order of segments
   * - Deduplicates similar segments at shard boundaries
   * - Merges entity lists
   *
   * @param results - VLM results from each shard
   * @returns Merged VLM index result
   */
  mergeShardResults(results: VLMIndexResult[]): VLMIndexResult {
    if (results.length === 0) {
      return { segments: [], entities: [], screenshots: [] };
    }

    if (results.length === 1) {
      return {
        ...results[0],
        screenshots: results[0].screenshots ?? [],
      };
    }

    // Collect all segments
    const allSegments: VLMSegment[] = [];
    for (const result of results) {
      allSegments.push(...result.segments);
    }

    // Deduplicate similar segments at boundaries
    const deduplicatedSegments = this.deduplicateBoundarySegments(allSegments);

    // Limit to max segments
    const limitedSegments = deduplicatedSegments.slice(0, this.maxSegmentsPerBatch);

    // Merge entities (unique)
    const entitySet = new Set<string>();
    for (const result of results) {
      for (const entity of result.entities) {
        entitySet.add(entity);
      }
    }
    const mergedEntities = Array.from(entitySet).slice(0, processingConfig.vlm.maxEntitiesPerBatch);

    // Merge screenshots (dedupe by screenshot_id, keep first occurrence)
    const mergedScreenshotsMap = new Map<number, VLMIndexResult["screenshots"][number]>();
    for (const result of results) {
      for (const shot of result.screenshots ?? []) {
        if (!mergedScreenshotsMap.has(shot.screenshot_id)) {
          mergedScreenshotsMap.set(shot.screenshot_id, shot);
        }
      }
    }
    const mergedScreenshots = Array.from(mergedScreenshotsMap.values());

    // Combine notes
    const notes = results
      .map((r) => r.notes)
      .filter(Boolean)
      .join(" | ");

    return {
      segments: limitedSegments,
      entities: mergedEntities,
      screenshots: mergedScreenshots,
      notes: notes || undefined,
    };
  }

  /**
   * Load base64 image data for screenshots in a shard
   *
   * @param shard - Shard with screenshots
   * @returns Shard with base64 data populated
   */
  async loadShardImages(shard: Shard): Promise<Shard> {
    const screenshotsWithData: ScreenshotWithData[] = [];

    for (const screenshot of shard.screenshots) {
      let base64 = "";

      if (screenshot.filePath) {
        try {
          const buffer = await fs.readFile(screenshot.filePath);
          base64 = buffer.toString("base64");
        } catch (error) {
          logger.warn(
            {
              screenshotId: screenshot.id,
              filePath: screenshot.filePath,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to load screenshot image"
          );
        }
      }

      screenshotsWithData.push({
        ...screenshot,
        base64,
      });
    }

    return {
      ...shard,
      screenshots: screenshotsWithData,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build screenshot metadata for VLM prompt
   *
   */
  private buildScreenshotMeta(screenshots: ScreenshotWithData[]): VLMScreenshotMeta[] {
    return screenshots.map((s, index) => ({
      index: index + 1, // 1-based index
      screenshot_id: s.id,
      captured_at: new Date(s.ts).toISOString(),
      source_key: s.sourceKey,
      app_hint: s.meta.appHint ?? null,
      window_title: s.meta.windowTitle ?? null,
    }));
  }

  /**
   * Build user prompt with screenshot metadata and history
   */
  private buildUserPrompt(
    screenshotMeta: VLMScreenshotMeta[],
    historyPack: HistoryPack,
    options?: { degraded?: boolean }
  ): string {
    const metaJson = JSON.stringify(screenshotMeta, null, 2);
    const canonicalCandidates = getCanonicalAppCandidates();
    const appCandidatesJson = JSON.stringify(canonicalCandidates, null, 2);

    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const utcOffsetMinutes = -now.getTimezoneOffset();
    const offsetSign = utcOffsetMinutes >= 0 ? "+" : "-";
    const offsetAbs = Math.abs(utcOffsetMinutes);
    const offsetHours = String(Math.floor(offsetAbs / 60)).padStart(2, "0");
    const offsetMins = String(offsetAbs % 60).padStart(2, "0");
    const utcOffset = `UTC${offsetSign}${offsetHours}:${offsetMins}`;
    const localTime = now.toLocaleString("sv-SE", { timeZone, hour12: false });

    let historySection = "";
    if (
      historyPack.recentThreads.length > 0 ||
      historyPack.openSegments.length > 0 ||
      historyPack.recentEntities.length > 0
    ) {
      historySection = `
## Recent Context (for continuity detection)

### Recent Threads
${
  historyPack.recentThreads.length > 0
    ? historyPack.recentThreads
        .map((t) => `- Thread "${t.threadId}": ${t.title} - ${t.lastEventSummary}`)
        .join("\n")
    : "None"
}

### Open Segments
${
  historyPack.openSegments.length > 0
    ? historyPack.openSegments.map((s) => `- ${s.segmentId}: ${s.summary}`).join("\n")
    : "None"
}

### Recent Entities
${historyPack.recentEntities.length > 0 ? historyPack.recentEntities.join(", ") : "None"}
`;
    }

    const degraded = options?.degraded === true;

    return promptTemplates.getVLMUserPrompt({
      screenshotMeta,
      historyPack,
      localTime,
      timeZone,
      utcOffset,
      now,
      metaJson,
      appCandidatesJson,
      historySection,
      degraded,
    });
  }

  /**
   * Process shards with concurrency limit
   */
  private async processShardsConcurrently(shards: Shard[]): Promise<ShardProcessResult[]> {
    const results: ShardProcessResult[] = new Array(shards.length);
    let nextIndex = 0;

    // Use global VLM concurrency limit from AI Semaphore config
    const workerCount = Math.max(1, Math.min(aiRuntimeService.getLimit("vlm"), shards.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex;
        nextIndex++;

        if (current >= shards.length) {
          return;
        }

        const shard = shards[current];
        try {
          const shardWithImages = shard.screenshots[0]?.base64
            ? shard
            : await this.loadShardImages(shard);
          const result = await this.processShard(shardWithImages);
          results[current] = { shardIndex: shard.shardIndex, success: true, result };
        } catch (error) {
          results[current] = {
            shardIndex: shard.shardIndex,
            success: false,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }
    });

    await Promise.all(workers);
    return results.sort((a, b) => a.shardIndex - b.shardIndex);
  }

  /**
   * Deduplicate similar segments at shard boundaries
   */
  private deduplicateBoundarySegments(segments: VLMSegment[]): VLMSegment[] {
    if (segments.length <= 1) {
      return segments;
    }

    const result: VLMSegment[] = [segments[0]];

    for (let i = 1; i < segments.length; i++) {
      const current = segments[i];
      const previous = result[result.length - 1];

      // Check if segments are similar (same title or very similar summary)
      if (this.areSegmentsSimilar(previous, current)) {
        // Merge into previous segment
        const merged = this.mergeSegments(previous, current);
        result[result.length - 1] = merged;
      } else {
        result.push(current);
      }
    }

    return result;
  }

  /**
   * Check if two segments are similar enough to merge
   */
  private areSegmentsSimilar(a: VLMSegment, b: VLMSegment): boolean {
    // Same title
    if (a.event.title.toLowerCase() === b.event.title.toLowerCase()) {
      return true;
    }

    // Similar summary (simple check - could be improved with embeddings)
    const aSummary = a.event.summary.toLowerCase();
    const bSummary = b.event.summary.toLowerCase();

    // Check word overlap
    const aWords = new Set(aSummary.split(/\s+/));
    const bWords = new Set(bSummary.split(/\s+/));
    const intersection = [...aWords].filter((w) => bWords.has(w));
    const union = new Set([...aWords, ...bWords]);

    const similarity = intersection.length / union.size;
    return similarity > 0.6; // 60% word overlap threshold
  }

  /**
   * Merge two similar segments
   */
  private mergeSegments(a: VLMSegment, b: VLMSegment): VLMSegment {
    return {
      segment_id: a.segment_id,
      screen_ids: [...new Set([...a.screen_ids, ...b.screen_ids])].sort((x, y) => x - y),
      event: {
        title: a.event.title,
        summary:
          a.event.summary.length >= b.event.summary.length ? a.event.summary : b.event.summary,
        confidence: Math.max(a.event.confidence, b.event.confidence),
        importance: Math.max(a.event.importance, b.event.importance),
      },
      derived: {
        knowledge: [...a.derived.knowledge, ...b.derived.knowledge],
        state: [...a.derived.state, ...b.derived.state],
        procedure: [...a.derived.procedure, ...b.derived.procedure],
        plan: [...a.derived.plan, ...b.derived.plan],
      },
      merge_hint: a.merge_hint,
      keywords: [...new Set([...(a.keywords || []), ...(b.keywords || [])])].slice(0, 10),
    };
  }

  /**
   * Update screenshot vlm_status to succeeded
   */
  private async updateScreenshotStatuses(
    batch: Batch,
    status: "succeeded" | "failed"
  ): Promise<void> {
    const db = getDb();
    const screenshotIds = batch.screenshots.map((s) => s.id);

    try {
      db.update(screenshots)
        .set({
          vlmStatus: status,
          updatedAt: Date.now(),
        })
        .where(inArray(screenshots.id, screenshotIds))
        .run();

      logger.debug(
        {
          batchId: batch.batchId,
          screenshotCount: screenshotIds.length,
          status,
        },
        "Updated screenshot statuses"
      );
    } catch (error) {
      logger.error(
        {
          batchId: batch.batchId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to update screenshot statuses"
      );
    }
  }
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when VLM response parsing fails
 */
export class VLMParseError extends Error {
  constructor(
    public readonly code: "NO_JSON_FOUND" | "JSON_PARSE_FAILED" | "SCHEMA_VALIDATION_FAILED",
    public readonly rawText: string,
    public readonly details?: string
  ) {
    super(`VLM parse error: ${code}${details ? ` - ${details}` : ""}`);
    this.name = "VLMParseError";
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const vlmProcessor = new VLMProcessor();

export const __test__ = {
  createProcessor: () => new VLMProcessor(),
};
