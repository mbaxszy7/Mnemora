/**
 * Deep Search Service
 *
 * Provides LLM-enhanced search capabilities:
 * - Query Understanding: Parse natural language queries into optimized search parameters
 * - Answer Synthesis: Generate structured answers from search results
 */

import { generateObject } from "ai";
import { AISDKService } from "../ai-sdk-service";
import { getLogger } from "../logger";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "../screen-capture/types";
import { llmUsageService } from "../usage/llm-usage-service";
import {
  SearchQueryPlanSchema,
  SearchQueryPlanProcessedSchema,
  SearchAnswerSchema,
  SearchAnswerProcessedSchema,
} from "./schemas";
import type {
  SearchQueryPlan,
  SearchAnswer,
  SearchFilters,
  ExpandedContextNode,
  ScreenshotEvidence,
  ContextKind,
} from "./types";
import { aiSemaphore } from "./ai-semaphore";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { aiConcurrencyConfig } from "./config";

const logger = getLogger("deep-search-service");

function getCanonicalAppCandidates(): string[] {
  return Object.keys(DEFAULT_WINDOW_FILTER_CONFIG.appAliases);
}

// ============================================================================
// Configuration Constants (internal defaults)
// ============================================================================

const QUERY_UNDERSTANDING_CONFIDENCE_THRESHOLD = 0.5;

// Payload limits
const MAX_NODES = 15;
const MAX_EVIDENCE = 25;
const MAX_CHARS_PER_NODE_SUMMARY = 600;
const MAX_SCREENSHOT_IDS_PER_NODE = 8;
const MAX_ENTITIES_PER_NODE = 8;
const MAX_KEYWORDS_PER_NODE = 10;
// Reserved for future extended evidence support:
// const MAX_OCR_EXCERPT_CHARS = 1000;
// const MAX_UI_SNIPPETS = 15;
// const MAX_CHARS_PER_UI_SNIPPET = 100;

const CANONICAL_APP_CANDIDATES = getCanonicalAppCandidates();

// ============================================================================
// System Prompts
// ============================================================================

const QUERY_UNDERSTANDING_SYSTEM_PROMPT = `You are a search query analyzer. Your task is to parse a user's natural language query and extract structured search parameters.

## Output Schema (JSON only)

{
  "embeddingText": string,      // Optimized text for semantic search (normalized entities, clear intent)
  "filtersPatch": {             // Optional extracted filters
    "timeRange": { "start": number, "end": number },  // Unix timestamps in milliseconds
    "appHint": string,          // Application name if mentioned (MUST be one of Canonical App Candidates)
    "entities": string[]        // Entity names mentioned (0-20, see rules)
  },
  "kindHint": "event" | "knowledge" | "state_snapshot" | "procedure" | "plan" | "entity_profile",
  "extractedEntities": string[], // 0-20 canonical named entities (see rules)
  "timeRangeReasoning": string, // Brief explanation of time parsing (debug; must not include sensitive content)
  "confidence": number          // 0-1, your confidence in the extraction
}

## Rules

1. **embeddingText**: Rephrase the query for better semantic matching. Remove filler words, normalize entity names.
2. **filtersPatch.timeRange**: Only include if user explicitly mentions time (e.g., "yesterday", "last week", "in March").
3. **filtersPatch.appHint**: Only include if user mentions a specific application. If provided, it MUST be one of the Canonical App Candidates provided in the prompt.
4. **Do NOT include threadId** in filtersPatch - that's user-controlled context.
5. **kindHint**: Infer what type of information the user is looking for.
6. **confidence**: Set lower if query is ambiguous or you're uncertain about extractions.
7. **extractedEntities** rules (same constraints as VLM entities):
   - 0-20 canonical named entities across the query.
   - Only meaningful named entities (person/project/team/org/app/repo/issue/ticket like "ABC-123").
   - EXCLUDE generic tech terms, libraries, commands, file paths, and folders like "npm", "node_modules", "dist", ".git".
   - EXCLUDE URLs without meaningful names.
   - Deduplicate and prefer canonical names.

## Important

- Return ONLY valid JSON, no markdown or explanations.
- If you cannot parse the query meaningfully, set confidence to 0.`;

const ANSWER_SYNTHESIS_SYSTEM_PROMPT = `You are a context-aware answer synthesizer. Your task is to generate a concise, accurate answer based on search results.

## Input

You will receive:
1. The user's original query
2. Retrieved context nodes with these fields:
   - id, kind, title, summary, keywords, entities, eventTime, threadId, screenshotIds
3. Screenshot evidence with these fields:
   - screenshotId, ts, appHint, windowTitle, storageState

## Output Schema (JSON only)

{
  "answerTitle": string,        // Optional short title for the answer (≤100 chars)
  "answer": string,             // Main answer text (concise, factual)
  "bullets": string[],          // Key bullet points (≤8 items)
  "citations": [                // References to source nodes/screenshots
    { "nodeId": number, "screenshotId": number, "quote": string }
  ],
  "confidence": number          // 0-1, based on evidence quality
}

## Rules

1. **Faithfulness**: ONLY use information from the provided context. Do NOT invent facts.
2. **Citations required**: Every claim must have at least one citation. Use nodeId or screenshotId from the input.
3. **Quote**: Short excerpt (≤80 chars) from the source as evidence. No sensitive information.
4. **Confidence**: Set lower if evidence is sparse or contradictory. Set very low if no relevant evidence.
5. **answer**: Keep concise and directly address the query.

## Important

- Return ONLY valid JSON, no markdown or explanations.
- If no relevant information is found, set confidence to 0.1 and explain in the answer.`;

// ============================================================================
// Helper Types for Payload Building
// ============================================================================

interface NodePayload {
  id: number;
  kind: ContextKind;
  title: string;
  summary: string;
  keywords: string[];
  entities: string[];
  eventTime?: number;
  threadId?: string;
  screenshotIds: number[];
  score?: number;
}

interface EvidencePayload {
  screenshotId: number;
  ts: number;
  appHint?: string;
  windowTitle?: string;
  storageState: string;
  ocrExcerpt?: string;
  uiSnippets?: string[];
}

interface GlobalSummary {
  resultTimeSpan: [number, number];
  topApps: Array<{ appHint: string; count: number }>;
  topEntities: string[];
  kindsBreakdown: Array<{ kind: string; count: number }>;
}

// ============================================================================
// DeepSearchService
// ============================================================================

export class DeepSearchService {
  /**
   * Understand user query and extract structured search parameters
   *
   * @param query - Natural language query
   * @param nowTs - Current timestamp (for relative time parsing)
   * @param timezone - User's timezone (e.g., "Asia/Shanghai")
   * @returns SearchQueryPlan or null on failure/timeout
   */
  async understandQuery(
    query: string,
    nowTs: number,
    timezone: string,
    abortSignal?: AbortSignal
  ): Promise<SearchQueryPlan | null> {
    const startTime = Date.now();

    // Acquire global text semaphore
    const release = await aiSemaphore.text.acquire();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), aiConcurrencyConfig.textTimeoutMs);
    const onAbort = () => controller.abort();
    abortSignal?.addEventListener("abort", onAbort);

    try {
      const aiService = AISDKService.getInstance();
      if (!aiService.isInitialized()) {
        logger.warn("AI SDK not initialized, skipping query understanding");
        return null;
      }

      const canonicalCandidatesJson = JSON.stringify(CANONICAL_APP_CANDIDATES, null, 2);
      const modelName = aiService.getTextModelName();

      // Calculate helpful time reference points for LLM
      const nowDate = new Date(nowTs);
      const todayStartLocal = new Date(nowDate);
      todayStartLocal.setHours(0, 0, 0, 0);
      const todayEndLocal = new Date(nowDate);
      todayEndLocal.setHours(23, 59, 59, 999);

      const prompt = `Current time: ${nowDate.toISOString()}
Current Unix timestamp (ms): ${nowTs}
Timezone: ${timezone}

## Time Reference Points (Unix milliseconds, use these for time calculations!)
- Today start (00:00:00 local): ${todayStartLocal.getTime()}
- Today end (23:59:59 local): ${todayEndLocal.getTime()}
- Yesterday start: ${todayStartLocal.getTime() - 86400000}
- Yesterday end: ${todayEndLocal.getTime() - 86400000}
- One week ago: ${nowTs - 7 * 86400000}

## Canonical App Candidates (for filtersPatch.appHint)
${canonicalCandidatesJson}

## App mapping rules (critical)
- filtersPatch.appHint MUST be a canonical name from the list above.
- If the user query uses an alias like "chrome", "google chrome", etc., map it to the canonical app name.
- If you cannot confidently map to one canonical app, OMIT filtersPatch.appHint.

## Time calculation rules (critical)
- ALWAYS use the Time Reference Points above for calculating filtersPatch.timeRange.
- For "today", use Today start and Today end timestamps directly.
- For "yesterday", use Yesterday start and Yesterday end timestamps directly.
- Do NOT calculate Unix timestamps from scratch - use the provided reference points!

User query: "${query}"

Parse this query and return the structured search parameters.`;

      const { object: rawResult, usage } = await generateObject({
        model: aiService.getTextClient(),
        system: QUERY_UNDERSTANDING_SYSTEM_PROMPT,
        schema: SearchQueryPlanSchema,
        prompt,
        abortSignal: controller.signal,
        providerOptions: {
          mnemora: {
            thinking: {
              type: "disabled",
            },
          },
        },
      });

      const parsed = SearchQueryPlanProcessedSchema.parse(rawResult);
      if (!parsed) {
        logger.warn("Query understanding: null result from generateObject");
        return null;
      }

      const durationMs = Date.now() - startTime;

      // Track usage
      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "deep_search_understand_query",
        status: "succeeded",
        model: modelName,
        totalTokens: usage?.totalTokens ?? null,
        usageStatus: usage?.totalTokens ? "present" : "missing",
      });

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "deep_search_understand_query",
        model: modelName,
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(parsed, null, 2),
      });

      logger.debug({ durationMs, confidence: parsed.confidence }, "Query understanding completed");

      return parsed;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Record failed usage
      try {
        const aiService = AISDKService.getInstance();
        const modelName = aiService.getTextModelName();

        llmUsageService.logEvent({
          ts: Date.now(),
          capability: "text",
          operation: "deep_search_understand_query",
          status: "failed",
          model: modelName,
          totalTokens: null,
          usageStatus: "missing",
          errorCode: error instanceof Error ? error.name : "unknown",
        });

        // Record trace for monitoring dashboard
        aiRequestTraceBuffer.record({
          ts: Date.now(),
          capability: "text",
          operation: "deep_search_understand_query",
          model: modelName,
          durationMs,
          status: "failed",
          errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      } catch {
        // Ignore usage recording errors
      }

      logger.warn(
        { error: error instanceof Error ? error.message : String(error), durationMs },
        "Query understanding failed"
      );
      return null;
    } finally {
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener("abort", onAbort);
      release();
    }
  }

  /**
   * Synthesize an answer from search results
   *
   * @param query - Original user query
   * @param nodes - Retrieved context nodes
   * @param evidence - Screenshot evidence
   * @returns SearchAnswer or null on failure/timeout
   */
  async synthesizeAnswer(
    query: string,
    nodes: ExpandedContextNode[],
    evidence: ScreenshotEvidence[],
    abortSignal?: AbortSignal
  ): Promise<SearchAnswer | null> {
    if (nodes.length === 0) {
      logger.debug("No nodes to synthesize answer from");
      return null;
    }

    const startTime = Date.now();

    // Acquire global text semaphore
    const release = await aiSemaphore.text.acquire();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), aiConcurrencyConfig.textTimeoutMs);
    const onAbort = () => controller.abort();
    abortSignal?.addEventListener("abort", onAbort);

    try {
      const aiService = AISDKService.getInstance();
      if (!aiService.isInitialized()) {
        logger.warn("AI SDK not initialized, skipping answer synthesis");
        return null;
      }

      const modelName = aiService.getTextModelName();

      // Build LLM payload
      const { nodesPayload, evidencePayload, globalSummary } = this.buildLLMPayload(
        nodes,
        evidence
      );

      const prompt = this.buildAnswerSynthesisPrompt(
        query,
        nodesPayload,
        evidencePayload,
        globalSummary
      );

      const { object: rawResult, usage } = await generateObject({
        model: aiService.getTextClient(),
        system: ANSWER_SYNTHESIS_SYSTEM_PROMPT,
        schema: SearchAnswerSchema,
        prompt,
        abortSignal: controller.signal,
        providerOptions: {
          mnemora: {
            thinking: {
              type: "enabled",
            },
          },
        },
      });

      const parsed = SearchAnswerProcessedSchema.parse(rawResult);
      const durationMs = Date.now() - startTime;

      // Track usage
      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "deep_search_synthesize_answer",
        status: "succeeded",
        model: modelName,
        totalTokens: usage?.totalTokens ?? null,
        usageStatus: usage?.totalTokens ? "present" : "missing",
      });

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "deep_search_synthesize_answer",
        model: modelName,
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(parsed, null, 2),
      });

      if (!parsed) {
        logger.warn("Answer synthesis: null result from generateObject");
        return null;
      }

      logger.debug({ durationMs, confidence: parsed.confidence }, "Answer synthesis completed");

      return parsed;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Record failed usage
      try {
        const aiService = AISDKService.getInstance();
        const modelName = aiService.getTextModelName();

        llmUsageService.logEvent({
          ts: Date.now(),
          capability: "text",
          operation: "deep_search_synthesize_answer",
          status: "failed",
          model: modelName,
          totalTokens: null,
          usageStatus: "missing",
          errorCode: error instanceof Error ? error.name : "unknown",
        });

        // Record trace for monitoring dashboard
        aiRequestTraceBuffer.record({
          ts: Date.now(),
          capability: "text",
          operation: "deep_search_synthesize_answer",
          model: modelName,
          durationMs,
          status: "failed",
          errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      } catch {
        // Ignore usage recording errors
      }

      logger.warn(
        { error: error instanceof Error ? error.message : String(error), durationMs },
        "Answer synthesis failed"
      );
      return null;
    } finally {
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener("abort", onAbort);
      release();
    }
  }

  /**
   * Merge query plan filters with user-provided filters
   * User's threadId is NEVER overwritten
   */
  mergeFilters(
    userFilters: SearchFilters | undefined,
    queryPlan: SearchQueryPlan | null
  ): SearchFilters {
    const result: SearchFilters = { ...userFilters };

    if (!queryPlan || queryPlan.confidence < QUERY_UNDERSTANDING_CONFIDENCE_THRESHOLD) {
      return result;
    }

    const patch = queryPlan.filtersPatch;
    if (!patch) {
      return result;
    }

    // Merge timeRange (only if user didn't specify)
    if (patch.timeRange && !result.timeRange) {
      result.timeRange = patch.timeRange;
    }

    // Merge appHint (only if user didn't specify)
    if (patch.appHint && !result.appHint) {
      result.appHint = patch.appHint;
    }

    // Merge entities (combine both)
    if (patch.entities && patch.entities.length > 0) {
      const existingEntities = result.entities ?? [];
      const combined = [...new Set([...existingEntities, ...patch.entities])];
      result.entities = combined;
    }

    // threadId is NEVER touched from queryPlan

    return result;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private buildLLMPayload(
    nodes: ExpandedContextNode[],
    evidence: ScreenshotEvidence[]
  ): {
    nodesPayload: NodePayload[];
    evidencePayload: EvidencePayload[];
    globalSummary: GlobalSummary;
  } {
    // Limit and transform nodes
    const limitedNodes = nodes.slice(0, MAX_NODES);
    const nodesPayload: NodePayload[] = limitedNodes.map((node) => ({
      id: node.id!,
      kind: node.kind,
      title: node.title,
      summary: this.truncateText(node.summary, MAX_CHARS_PER_NODE_SUMMARY),
      keywords: node.keywords.slice(0, MAX_KEYWORDS_PER_NODE),
      entities: node.entities.slice(0, MAX_ENTITIES_PER_NODE).map((e) => e.name),
      eventTime: node.eventTime,
      threadId: node.threadId,
      screenshotIds: node.screenshotIds.slice(0, MAX_SCREENSHOT_IDS_PER_NODE),
    }));

    // Get screenshot IDs referenced by top nodes
    const nodeScreenshotIds = new Set<number>();
    for (const node of limitedNodes) {
      for (const sid of node.screenshotIds.slice(0, MAX_SCREENSHOT_IDS_PER_NODE)) {
        nodeScreenshotIds.add(sid);
      }
    }

    // Prioritize evidence linked to top nodes, then by recency
    const sortedEvidence = [...evidence].sort((a, b) => {
      const aLinked = nodeScreenshotIds.has(a.screenshotId) ? 1 : 0;
      const bLinked = nodeScreenshotIds.has(b.screenshotId) ? 1 : 0;
      if (aLinked !== bLinked) return bLinked - aLinked;
      return b.ts - a.ts;
    });

    const limitedEvidence = sortedEvidence.slice(0, MAX_EVIDENCE);
    const evidencePayload: EvidencePayload[] = limitedEvidence.map((e) => ({
      screenshotId: e.screenshotId,
      ts: e.ts,
      appHint: e.appHint,
      windowTitle: e.windowTitle,
      storageState: e.storageState,
      // Note: ocrExcerpt and uiSnippets would come from extended evidence
      // For now we only have the basic ScreenshotEvidence fields
    }));

    // Build global summary
    const globalSummary = this.buildGlobalSummary(limitedNodes, limitedEvidence);

    return { nodesPayload, evidencePayload, globalSummary };
  }

  private buildGlobalSummary(
    nodes: ExpandedContextNode[],
    evidence: ScreenshotEvidence[]
  ): GlobalSummary {
    // Time span
    const nodeTimes = nodes.map((n) => n.eventTime).filter((t): t is number => t !== undefined);
    const evidenceTimes = evidence.map((e) => e.ts);
    const allTimes = [...nodeTimes, ...evidenceTimes];
    const minTs = allTimes.length > 0 ? Math.min(...allTimes) : 0;
    const maxTs = allTimes.length > 0 ? Math.max(...allTimes) : 0;

    // Top apps
    const appCounts = new Map<string, number>();
    for (const e of evidence) {
      if (e.appHint) {
        appCounts.set(e.appHint, (appCounts.get(e.appHint) ?? 0) + 1);
      }
    }
    const topApps = Array.from(appCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([appHint, count]) => ({ appHint, count }));

    // Top entities
    const entitySet = new Set<string>();
    for (const node of nodes) {
      for (const entity of node.entities) {
        entitySet.add(entity.name);
      }
    }
    const topEntities = Array.from(entitySet).slice(0, 10);

    // Kinds breakdown
    const kindCounts = new Map<string, number>();
    for (const node of nodes) {
      kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1);
    }
    const kindsBreakdown = Array.from(kindCounts.entries()).map(([kind, count]) => ({
      kind,
      count,
    }));

    return {
      resultTimeSpan: [minTs, maxTs],
      topApps,
      topEntities,
      kindsBreakdown,
    };
  }

  private buildAnswerSynthesisPrompt(
    query: string,
    nodes: NodePayload[],
    evidence: EvidencePayload[],
    globalSummary: GlobalSummary
  ): string {
    return `## User Query
"${query}"

## Global Summary
- Time span: ${new Date(globalSummary.resultTimeSpan[0]).toISOString()} to ${new Date(globalSummary.resultTimeSpan[1]).toISOString()}
- Top apps: ${globalSummary.topApps.map((a) => `${a.appHint} (${a.count})`).join(", ") || "none"}
- Top entities: ${globalSummary.topEntities.join(", ") || "none"}
- Kinds: ${globalSummary.kindsBreakdown.map((k) => `${k.kind}: ${k.count}`).join(", ")}

## Context Nodes (${nodes.length})
${JSON.stringify(nodes, null, 2)}

## Screenshot Evidence (${evidence.length})
${JSON.stringify(evidence, null, 2)}

Based on the above context, provide a structured answer to the user's query.`;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }
}

export const deepSearchService = new DeepSearchService();
