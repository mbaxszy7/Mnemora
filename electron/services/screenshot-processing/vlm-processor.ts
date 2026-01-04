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
import { vlmConfig } from "./config";
import {
  VLMIndexResultSchema,
  VLMIndexResultProcessedSchema,
  type VLMIndexResult,
  type VLMSegment,
  type VLMScreenshotMeta,
} from "./schemas";
import type { Shard, HistoryPack, Batch, ScreenshotWithData } from "./types";
import { llmUsageService } from "../usage/llm-usage-service";
import { aiFailureCircuitBreaker } from "../ai-failure-circuit-breaker";

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

const VLM_SYSTEM_PROMPT = `You are an expert screenshot analyst for a personal activity tracking system.

Your goal is to produce a compact, fully structured JSON index that can be stored and used later without the images.

Interpretation rules:
- A "segment" represents ONE coherent user activity (an Event). If the batch contains multiple distinct activities, output multiple segments.
  - The "derived" items are optional extractions tied to the segment's Event. They correspond to:
    - knowledge: reusable facts/concepts (no user actions)
    - state: a snapshot of some object's status at that time
    - procedure: reusable step-by-step process inferred from a sequence
    - plan: explicit future intentions/todos

Extraction strategy:
- Always extract the Event first (what current_user is doing).
- Then proactively extract derived items when the screenshots contain them:
  - docs/specs/architecture/config explanations => knowledge
  - dashboards/boards/status panels/metrics => state
  - reusable multi-step operational flow => procedure
  - explicit todos/next steps/future goals => plan

Style matching (very important):
- event: MUST describe user behavior with subject "current_user" (e.g. "current_user editing...", "current_user debugging...").
- knowledge/state/procedure: MUST NOT describe user behavior; describe the knowledge/state/process itself.
- plan: MUST describe future intent/todo content.

Subject identification:
- "current_user" is the screen operator (the photographer of these screenshots).
- Names visible in screenshots (people/orgs/etc.) are not automatically "current_user"; keep them as separate entities.

## Output JSON (must be valid JSON and must follow this structure EXACTLY)
{
  "segments": [
    {
      "segment_id": "seg_1",
      "screen_ids": [1, 2],
      "event": {
        "title": "current_user debugging CI pipeline in Jenkins",
        "summary": "current_user reviewing failed build logs in Jenkins dashboard, investigating test failures",
        "confidence": 8,
        "importance": 7
      },
      "derived": {
        "knowledge": [
          {"title": "Jenkins pipeline configuration", "summary": "Pipeline uses 3 stages: build, test, deploy. Source URL: https://jenkins.example.com/job/main"}
        ],
        "state": [
          {"title": "CI build status", "summary": "Build #456 failed at test stage with 2 failing unit tests", "object": "Jenkins pipeline"}
        ],
        "procedure": [],
        "plan": []
      },
      "merge_hint": {
        "decision": "NEW"
      },
      "keywords": ["debugging", "CI", "Jenkins", "build failure"]
    }
  ],
  "entities": ["Jenkins", "Build #456"],
  "screenshots": [
    {
      "screenshot_id": 123,
      "app_guess": { "name": "Google Chrome", "confidence": 0.82 },
      "ocr_text": "...",
      "ui_text_snippets": ["Build #456 failed", "2 tests failed"]
    }
  ],
  "notes": "Optional notes"
}

## Segment rules (Event extraction)
- Output 1-4 segments total.
- Each segment must be semantically coherent (one clear task/goal). Do NOT mix unrelated tasks into the same segment.
- Prefer grouping adjacent screenshots that are part of the same activity.
- "screen_ids" are 1-based indices within THIS batch (not database IDs).
- "segment_id" must be unique within this JSON output (recommended format: "seg_<unique>").

## event (title/summary) rules
- Style: describe "who is doing what" in natural language. Use "current_user" as the subject.
- title (<=100 chars): specific, action-oriented.
- summary (<=200 chars): include concrete details (what app/page, what is being edited/viewed/decided, key identifiers like PR/issue IDs). Avoid vague phrases like "working on stuff".
- confidence: 0-10 based on clarity of evidence.
- importance: 0-10 based on how valuable this activity would be for later recall/search.

## derived rules (CRITICAL - follow exact schema)
- General: derived items must be grounded in visible evidence from the screenshots. Do NOT invent.
- **IMPORTANT: ALL derived items (knowledge, state, procedure, plan) MUST have exactly these fields:**
  - "title": string (<=100 chars) - a short descriptive title
  - "summary": string (<=180 chars) - a brief description
  - "steps": array of strings (ONLY for procedure items, each step <=80 chars)
  - "object": string (OPTIONAL, only for state items to specify what is being tracked)
- **Max 2 items per derived category (knowledge, state, procedure, plan)**

### Derived item JSON examples (use EXACTLY this structure):
- knowledge item: {"title": "API rate limiting rules", "summary": "Rate limit is 100 req/min per user. Source URL: https://docs.example.com/api"}
- state item: {"title": "CI pipeline status", "summary": "Build #456 failed on test stage with 3 failing tests", "object": "CI pipeline"}
- procedure item: {"title": "Deploy to production", "summary": "Standard deployment workflow for the main app", "steps": ["Run tests locally", "Create PR", "Wait for CI", "Merge and deploy"]}
- plan item: {"title": "Refactor auth module", "summary": "Plan to migrate from JWT to session-based auth next sprint"}

### What NOT to do (these will cause validation errors):
- WRONG state: {"object": "Server", "status": "running", "details": "..."} - missing title and summary!
- WRONG procedure: {"title": "...", "steps": [...]} - missing summary!
- WRONG: more than 2 items in any derived category

## merge_hint rules (thread continuity) - CRITICAL
- Default: "decision" = "NEW" (use this in most cases)
- Use "MERGE" ONLY if ALL of these conditions are met:
  1. Recent threads are provided in the history context below
  2. This segment is clearly continuing the SAME activity from a provided thread
  3. You set "thread_id" to the EXACT thread_id from the provided history
- **If no history is provided or you cannot match a thread_id, you MUST use "NEW"**
- **NEVER use "MERGE" without providing a valid "thread_id" from the history**

## keywords rules
- 0-10 short keywords that help search (topic + action). Avoid overly broad terms.

## Length Limits
- title: max 100 characters.
- summary: max 500 characters. Be concise but descriptive. If the screen contains complex data (e.g. database schema, code logic, log errors), include specific details in the summary.

## entities rules
- 0-20 canonical named entities across the whole batch (people/orgs/teams/apps/products/repos/projects/tickets like "ABC-123").
- EXCLUDE generic tech terms, libraries, commands, file paths, and folders like "npm", "node_modules", "dist", ".git".

## screenshots evidence rules
- Include one entry for EVERY screenshot in the input metadata.
- "screenshot_id" must exactly match the database id from the input metadata.
- app_guess (optional): Identify the main application shown in the screenshot.
  - name: MUST be one of the provided canonical candidate apps OR one of: "unknown", "other".
  - confidence: 0..1. Use >= 0.7 only when you are fairly sure.
- ocr_text (optional, <=8000 chars): copy visible text in reading order; remove obvious noise/repeated boilerplate.
- ui_text_snippets (optional, <=20 items, each <=200 chars): pick the highest-signal lines (titles, decisions, issue IDs, key chat messages). Deduplicate. Exclude timestamps-only lines, hashes, and directory paths.

## Privacy / redaction
- If you see secrets (API keys, tokens, passwords, private keys), replace the sensitive part with "***".

## Hard rules
1) Return ONLY a single JSON object matching the requested schema.
2) Respect all max counts and length limits.
3) Avoid abstract generalizations (e.g. "reviewed something", "worked on code"); include specific details visible in the screenshots.
4) If something is absent, use empty arrays or omit optional fields; never hallucinate.
5) ALL segments MUST have an "event" object with "title" and "summary" - this is mandatory.
6) ALL derived items MUST have "title" and "summary" fields - no exceptions.
7) The output MUST be a valid JSON object. Do not include markdown code blocks or any other text.`;

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
   *
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

    try {
      // Call VLM with timing
      const apiCallStart = Date.now();
      const { object: rawResult, usage } = await generateObject({
        model: aiService.getVLMClient(),
        schema: VLMIndexResultSchema,
        system: request.system,
        messages: [
          {
            role: "user",
            content: request.userContent,
          },
        ],
        providerOptions: {
          mnemora: {
            thinking: {
              type: "disabled",
            },
          },
        },
        maxOutputTokens: vlmConfig.maxTokens,
      });

      // Normalize and clean up the result using the processed schema
      const result = VLMIndexResultProcessedSchema.parse(rawResult);
      timings.apiCall = Date.now() - apiCallStart;

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
    } catch (error) {
      const totalMs = Date.now() - processStartTime;

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
      aiFailureCircuitBreaker.recordFailure("vlm", error);

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
    const mergedEntities = Array.from(entitySet).slice(0, vlmConfig.maxEntitiesPerBatch);

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
  private buildUserPrompt(screenshotMeta: VLMScreenshotMeta[], historyPack: HistoryPack): string {
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

    return `Analyze the following ${screenshotMeta.length} screenshots and produce the structured JSON described in the system prompt.

## Current User Time Context (for relative time interpretation)
- local_time: ${localTime}
- time_zone: ${timeZone}
- utc_offset: ${utcOffset}
- now_utc: ${now.toISOString()}

## Screenshot Metadata (order = screen_id)
${metaJson}

## Canonical App Candidates (for app_guess.name)
${appCandidatesJson}

## App mapping rules (critical)
- app_guess.name MUST be a canonical name from the list above.
- If the UI shows aliases like "Chrome", "google chrome", "arc", etc., map them to the canonical app name.
- If you cannot confidently map to one canonical app, use "unknown" or "other" with low confidence.
${historySection}
## Field-by-field requirements
- segments: max 4. Titles/summaries must be specific and human-readable. Keep confidence/importance on 0-10.
- merge_hint: Use MERGE only when clearly continuing a provided thread_id from the history above; otherwise ALWAYS use NEW. Never use MERGE without a valid thread_id.
- derived: CRITICAL SCHEMA - every derived item (knowledge/state/procedure/plan) MUST have both "title" and "summary" fields. Max 2 per category.
  - Example state: {"title": "Build status", "summary": "CI build #123 failed on tests", "object": "CI pipeline"}
  - Example procedure: {"title": "Deploy workflow", "summary": "Steps to deploy to prod", "steps": ["Build", "Test", "Deploy"]}
  - WRONG: {"object": "X", "status": "Y", "details": "Z"} - this is INVALID, missing title/summary!
- entities: Only meaningful named entities (person/project/team/org/app/repo/issue/ticket). Exclude generic tech/library/runtime terms (npm, node_modules, yarn, dist, build, .git), file paths, URLs without names, commands, or placeholders. Use canonical names; dedupe.
- screenshots: For each screenshot_id from the metadata:
  - screenshot_id: must match the input metadata screenshot_id (do NOT invent ids).
  - app_guess: optional; if present must follow Canonical App Candidates + App mapping rules; confidence is 0..1.
  - ocr_text: full readable text in visible order, trimmed to 8000 chars; remove binary noise and repeated boilerplate.
  - ui_text_snippets: pick 5-15 high-signal sentences/phrases (chat bubbles, titles, decisions, issue IDs). Drop duplicates, timestamps-only lines, hashes, directory paths.
- notes: optional; only if useful.

## Instructions
1. Review all screenshots in order (1..${screenshotMeta.length}).
2. Identify segments and assign screen_ids for each.
3. Fill every field following the constraints above.
4. Return ONLY the JSON object—no extra text or code fences.`;
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
