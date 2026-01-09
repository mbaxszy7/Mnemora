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
import { llmUsageService } from "../llm-usage-service";
import { promptTemplates } from "./prompt-templates";
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
import { processingConfig } from "./config";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { aiRuntimeService } from "../ai-runtime-service";

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

// ============================================================================
// Helper Types for Payload Building
// ============================================================================

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
  eventTime: number;
  localTime: string;
  threadId?: string;
  screenshotIds: number[];
  score?: number;
}

interface EvidencePayload {
  screenshotId: number;
  timestamp: number;
  localTime: string;
  appHint?: string;
  windowTitle?: string;
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
    const release = await aiRuntimeService.acquire("text");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);
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

      const prompt = promptTemplates.getQueryUnderstandingUserPrompt({
        nowDate,
        nowTs,
        timezone,
        todayStart: todayStartLocal.getTime(),
        todayEnd: todayEndLocal.getTime(),
        yesterdayStart: todayStartLocal.getTime() - 86400000,
        yesterdayEnd: todayEndLocal.getTime() - 86400000,
        weekAgo: nowTs - 7 * 86400000,
        canonicalCandidatesJson,
        userQuery: query,
      });

      const { object: rawResult, usage } = await generateObject({
        model: aiService.getTextClient(),
        system: promptTemplates.getQueryUnderstandingSystemPrompt(),
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

      aiRuntimeService.recordSuccess("text");

      logger.debug({ durationMs, confidence: parsed.confidence }, "Query understanding completed");

      return parsed;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      aiRuntimeService.recordFailure("text", error, { tripBreaker: false });

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
    nowTs: number,
    timezone: string,
    abortSignal?: AbortSignal
  ): Promise<SearchAnswer | null> {
    if (nodes.length === 0) {
      logger.debug("No nodes to synthesize answer from");
      return null;
    }

    const startTime = Date.now();

    // Acquire global text semaphore
    const release = await aiRuntimeService.acquire("text");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);
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
        evidence,
        timezone
      );

      const prompt = this.buildAnswerSynthesisPrompt(
        query,
        nodesPayload,
        evidencePayload,
        globalSummary,
        nowTs,
        timezone
      );

      const { object: rawResult, usage } = await generateObject({
        model: aiService.getTextClient(),
        system: promptTemplates.getAnswerSynthesisSystemPrompt(),
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

      aiRuntimeService.recordSuccess("text");

      if (!parsed) {
        logger.warn("Answer synthesis: null result from generateObject");
        return null;
      }

      logger.debug({ durationMs, confidence: parsed.confidence }, "Answer synthesis completed");

      return parsed;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      aiRuntimeService.recordFailure("text", error, { tripBreaker: false });

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
    evidence: ScreenshotEvidence[],
    timezone: string
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
      eventTime: node.eventTime ?? 0,
      localTime: this.formatTime(node.eventTime, timezone),
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
      return b.timestamp - a.timestamp;
    });

    const limitedEvidence = sortedEvidence.slice(0, MAX_EVIDENCE);
    const evidencePayload: EvidencePayload[] = limitedEvidence.map((e) => ({
      screenshotId: e.screenshotId,
      timestamp: e.timestamp,
      localTime: this.formatTime(e.timestamp, timezone),
      appHint: e.appHint,
      windowTitle: e.windowTitle,
      uiSnippets: e.uiTextSnippets, // Map from EvidencePack fields
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
    const evidenceTimes = evidence.map((e) => e.timestamp);
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
    globalSummary: GlobalSummary,
    nowTs: number,
    timezone: string
  ): string {
    const nowDate = new Date(nowTs);
    const localTime = nowDate.toLocaleString("sv-SE", { timeZone: timezone, hour12: false });

    const formattedTimeSpanStart = this.formatTime(globalSummary.resultTimeSpan[0], timezone);
    const formattedTimeSpanEnd = this.formatTime(globalSummary.resultTimeSpan[1], timezone);
    const topAppsStr =
      globalSummary.topApps.map((a) => `${a.appHint} (${a.count})`).join(", ") || "none";
    const topEntitiesStr = globalSummary.topEntities.join(", ") || "none";
    const kindsStr = globalSummary.kindsBreakdown.map((k) => `${k.kind}: ${k.count}`).join(", ");

    return promptTemplates.getAnswerSynthesisUserPrompt({
      userQuery: query,
      localTime,
      timeZone: timezone,
      nowDate,
      formattedTimeSpanStart,
      formattedTimeSpanEnd,
      topAppsStr,
      topEntitiesStr,
      kindsStr,
      nodesJson: JSON.stringify(nodes, null, 2),
      evidenceJson: JSON.stringify(evidence, null, 2),
    });
  }

  private formatTime(ts: number | undefined, timezone: string): string {
    if (!ts) return "unknown";
    return new Date(ts).toLocaleString("sv-SE", { timeZone: timezone, hour12: false });
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }
}

export const deepSearchService = new DeepSearchService();
