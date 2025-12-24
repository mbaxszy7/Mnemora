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
 * Design reference: design.md Section 4.4 VLM 处理
 * Requirements: CP-5 (元信息完整性), CP-7 (Zod 验证)
 */

import fs from "node:fs/promises";
import { generateText } from "ai";
import { inArray } from "drizzle-orm";

import { getDb } from "../../database";
import { screenshots } from "../../database/schema";
import { AISDKService } from "../ai-sdk-service";
import { getLogger } from "../logger";
import { vlmConfig } from "./config";
import {
  VLMIndexResultSchema,
  type VLMIndexResult,
  type VLMSegment,
  type VLMScreenshotMeta,
} from "./schemas";
import type { Shard, HistoryPack, Batch, ScreenshotWithData } from "./types";

const logger = getLogger("vlm-processor");

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

const VLM_SYSTEM_PROMPT = `You are an expert screenshot analyzer for a personal activity tracking system. Your task is to analyze a sequence of screenshots and extract structured information about user activities.

## Task
Analyze the provided screenshots and identify distinct activity segments. For each segment:
1. Identify the main event/activity happening
2. Extract any knowledge, state changes, procedures, or plans
3. Determine if this continues an existing activity thread or starts a new one

## Output Format
Return a JSON object with this exact structure:
{
  "segments": [
    {
      "segment_id": "seg_<unique_id>",
      "screen_ids": [1, 2],  // 1-based indices of screenshots in this segment
      "event": {
        "title": "Brief title (max 100 chars)",
        "summary": "What happened (max 200 chars)",
        "confidence": 8,  // 0-10 scale
        "importance": 7   // 0-10 scale
      },
      "derived": {
        "knowledge": [{"title": "...", "summary": "..."}],  // max 2 items
        "state": [{"title": "...", "summary": "...", "object": "..."}],  // max 2 items
        "procedure": [{"title": "...", "summary": "...", "steps": ["..."]}],  // max 2 items
        "plan": [{"title": "...", "summary": "..."}]  // max 2 items
      },
      "merge_hint": {
        "decision": "NEW" or "MERGE",
        "thread_id": "thread_xxx"  // required if MERGE
      },
      "keywords": ["keyword1", "keyword2"]  // max 10
    }
  ],
  "entities": ["Entity Name 1", "Entity Name 2"],  // max 20 canonical names
  "notes": "Optional notes about the analysis"
}

## Rules
1. Maximum 4 segments per batch
2. Each derived category (knowledge, state, procedure, plan) has max 2 items
3. Title max 100 chars, summary max 200 chars
4. Use "MERGE" only if you're confident this continues a thread from the history
5. Return ONLY valid JSON, no markdown code blocks or extra text`;

// ============================================================================
// VLMProcessor Class
// ============================================================================

/**
 * VLMProcessor handles VLM-based screenshot analysis
 */
class VLMProcessor {
  private readonly concurrency: number;
  private readonly maxSegmentsPerBatch: number;

  constructor(options?: { concurrency?: number; maxSegmentsPerBatch?: number }) {
    this.concurrency = options?.concurrency ?? vlmConfig.vlmConcurrency;
    this.maxSegmentsPerBatch = options?.maxSegmentsPerBatch ?? vlmConfig.maxSegmentsPerBatch;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build VLM request from a shard
   *
   * Ensures CP-5: Each screenshot includes required metadata
   * (screenshot_id, captured_at, source_key, app_hint, window_title)
   *
   * @param shard - Shard with screenshots and history pack
   * @returns VLM request ready for AI SDK
   */
  buildVLMRequest(shard: Shard): VLMRequest {
    const screenshotMeta = this.buildScreenshotMeta(shard.screenshots);
    const userPrompt = this.buildUserPrompt(screenshotMeta, shard.historyPack);

    const userContent: VLMRequest["userContent"] = [{ type: "text", text: userPrompt }];

    // Add images
    for (const screenshot of shard.screenshots) {
      if (screenshot.base64) {
        const mime = screenshot.meta.mime || "image/png";
        userContent.push({
          type: "image",
          image: `data:${mime};base64,${screenshot.base64}`,
        });
      }
    }

    return {
      system: VLM_SYSTEM_PROMPT,
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
    const aiService = AISDKService.getInstance();

    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    // Build request
    const request = this.buildVLMRequest(shard);

    logger.debug(
      {
        shardIndex: shard.shardIndex,
        screenshotCount: shard.screenshots.length,
      },
      "Processing shard through VLM"
    );

    try {
      // Call VLM
      const { text: rawText } = await generateText({
        model: aiService.getVLMClient(),
        system: request.system,
        messages: [
          {
            role: "user",
            content: request.userContent,
          },
        ],
      });

      // Parse response
      const result = this.parseVLMResponse(rawText);

      logger.debug(
        {
          shardIndex: shard.shardIndex,
          segmentCount: result.segments.length,
          entityCount: result.entities.length,
        },
        "Successfully processed shard"
      );

      return result;
    } catch (error) {
      logger.error(
        {
          shardIndex: shard.shardIndex,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to process shard"
      );
      throw error;
    }
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
        concurrency: this.concurrency,
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
          errors: failedShards.map((r) => r.error),
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
      return { segments: [], entities: [] };
    }

    if (results.length === 1) {
      return results[0];
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
    const mergedEntities = Array.from(entitySet).slice(0, vlmConfig.maxEntitiesPerBatch);

    // Combine notes
    const notes = results
      .map((r) => r.notes)
      .filter(Boolean)
      .join(" | ");

    return {
      segments: limitedSegments,
      entities: mergedEntities,
      notes: notes || undefined,
    };
  }

  /**
   * Parse VLM response text into structured result
   *
   * Ensures CP-7: Uses Zod validation for schema compliance
   *
   * @param rawText - Raw text response from VLM
   * @returns Parsed and validated VLM index result
   */
  parseVLMResponse(rawText: string): VLMIndexResult {
    // Try to extract JSON
    let jsonStr = rawText.trim();

    // Remove markdown code block if present
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Try to find JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Try to repair and retry
      const repaired = this.repairVLMResponse(rawText);
      const repairedMatch = repaired.match(/\{[\s\S]*\}/);
      if (!repairedMatch) {
        throw new VLMParseError("NO_JSON_FOUND", rawText);
      }
      jsonStr = repairedMatch[0];
    } else {
      jsonStr = jsonMatch[0];
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // Try repair
      const repaired = this.repairVLMResponse(jsonStr);
      try {
        parsed = JSON.parse(repaired);
      } catch {
        throw new VLMParseError(
          "JSON_PARSE_FAILED",
          rawText,
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    // Validate with Zod
    const result = VLMIndexResultSchema.safeParse(parsed);
    if (!result.success) {
      throw new VLMParseError("SCHEMA_VALIDATION_FAILED", rawText, result.error.message);
    }

    return result.data;
  }

  /**
   * Repair common JSON format issues in VLM response
   *
   * @param rawText - Raw text that may have JSON issues
   * @returns Repaired text
   */
  repairVLMResponse(rawText: string): string {
    let text = rawText;

    // Remove markdown code blocks
    text = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");

    // Remove trailing commas before closing brackets
    text = text.replace(/,(\s*[}\]])/g, "$1");

    // Fix unquoted keys (simple cases)
    text = text.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

    // Fix single quotes to double quotes
    text = text.replace(/'/g, '"');

    // Remove control characters
    text = text.replace(/[\p{Cc}]/gu, " ");

    // Try to extract just the JSON object
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      text = match[0];
    }

    return text;
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
   * Ensures CP-5: All required fields are present
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
  private buildUserPrompt(screenshotMeta: VLMScreenshotMeta[], historyPack: HistoryPack): string {
    const metaJson = JSON.stringify(screenshotMeta, null, 2);

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

    return `Analyze the following ${screenshotMeta.length} screenshots and extract activity information.

## Screenshot Metadata
${metaJson}
${historySection}
## Instructions
1. Examine each screenshot carefully
2. Identify distinct activity segments
3. For each segment, determine if it continues an existing thread (use MERGE) or starts new (use NEW)
4. Extract any knowledge, state changes, procedures, or plans
5. Return the structured JSON response

The images follow in order (1 to ${screenshotMeta.length}).`;
  }

  /**
   * Process shards with concurrency limit
   */
  private async processShardsConcurrently(shards: Shard[]): Promise<ShardProcessResult[]> {
    const results: ShardProcessResult[] = new Array(shards.length);
    let nextIndex = 0;

    const workerCount = Math.max(1, Math.min(this.concurrency, shards.length));
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
        knowledge: [...a.derived.knowledge, ...b.derived.knowledge].slice(0, 2),
        state: [...a.derived.state, ...b.derived.state].slice(0, 2),
        procedure: [...a.derived.procedure, ...b.derived.procedure].slice(0, 2),
        plan: [...a.derived.plan, ...b.derived.plan].slice(0, 2),
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

const vlmProcessor = new VLMProcessor();

export const __test__ = {
  createProcessor: (options?: { concurrency?: number; maxSegmentsPerBatch?: number }) =>
    new VLMProcessor(options),
};

export async function runVlmOnBatch(
  batch: Batch,
  shards: Shard[],
  options?: { concurrency?: number; maxSegmentsPerBatch?: number }
): Promise<VLMIndexResult> {
  const processor = options ? new VLMProcessor(options) : vlmProcessor;
  const result = await processor.processBatch(batch, shards);

  if (result.success && result.mergedResult) {
    return result.mergedResult;
  }

  const firstError = result.shardResults.find((r) => !r.success)?.error;
  if (firstError) {
    throw firstError;
  }

  throw new Error(result.error ?? "VLM batch processing failed");
}
