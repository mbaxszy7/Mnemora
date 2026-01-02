/**
 * Text LLM Processor
 *
 * Responsible for:
 * - Expanding VLM Index results into storable ContextGraph nodes
 * - Processing merge_hint decisions (NEW vs MERGE)
 * - Creating event nodes with derived nodes (knowledge/state/procedure/plan)
 * - Merging nodes while preserving evidence links
 * - Writing to ContextGraphService in a single transaction
 *
 */

import crypto from "node:crypto";
import { generateText } from "ai";
import { z } from "zod";

import { AISDKService } from "../ai-sdk-service";
import { getLogger } from "../logger";
import { contextGraphService, type CreateNodeInput } from "./context-graph-service";
import { entityService } from "./entity-service";
import { llmUsageService } from "../usage/llm-usage-service";
import { parseTextLLMExpandResult } from "./schemas";

import type { VLMIndexResult, VLMSegment, DerivedItem, TextLLMExpandResult } from "./schemas";
import type {
  Batch,
  ExpandedContextNode,
  EntityRef,
  ContextKind,
  EvidencePack as EvidencePackType,
} from "./types";
import { aiFailureCircuitBreaker } from "../ai-failure-circuit-breaker";

const logger = getLogger("text-llm-processor");

// ============================================================================
// Types
// ============================================================================

/**
 * Evidence pack for a screenshot (minimal evidence for retrieval)
 */
type EvidencePack = EvidencePackType;

/**
 * Result of expanding VLM Index to context nodes
 */
export interface ExpandResult {
  /** Created node IDs */
  nodeIds: string[];
  /** Thread IDs created or used */
  threadIds: string[];
  /** Whether processing was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Merge result for combining nodes
 */
export interface MergeResult {
  /** The merged node */
  mergedNode: ExpandedContextNode;
  /** IDs of nodes that were merged */
  mergedFromIds: number[];
}

/**
 * Internal node representation before DB write
 */
interface PendingNode {
  kind: ContextKind;
  threadId?: string;
  title: string;
  summary: string;
  keywords: string[];
  entities: EntityRef[];
  importance: number;
  confidence: number;
  screenshotIds: number[];
  eventTime?: number;
  /** For derived nodes, the index of the source event in the pending nodes array */
  sourceEventIndex?: number;
}

// ============================================================================
// Text LLM System Prompt
// ============================================================================

const TEXT_LLM_SYSTEM_PROMPT = `You are a top AI analyst and context-structuring expert. Your task is to convert a VLM Index (segments + evidence) into a compact, queryable ContextGraph update.

Core Principles:
1. Faithfulness: Do not invent facts. Only use information present in the input.
2. Content Fusion: Integrate related details into coherent nodes. Avoid fragmentation and redundancy.
3. Traceability: Every node must reference database screenshot IDs via "screenshot_ids". Every derived node must be linked to its source event via an edge.
4. Searchability: Titles and summaries must be specific (include concrete identifiers like file names, tickets, commands, UI labels when present). Keywords must be high-signal and deduplicated.
5. Thread Continuity: Each event node must have "thread_id". Respect merge_hint: if decision is MERGE and thread_id is present, reuse it; otherwise create a new thread_id.

Output Format:
Return ONLY valid JSON with:
- "nodes": array of nodes
- "edges": array of edges (optional)

Node schema:
- "kind": "event" | "knowledge" | "state_snapshot" | "procedure" | "plan"
- "thread_id": string (required for kind="event", omit otherwise)
- "title": string (<= 100 chars)
- "summary": string (<= 200 chars)
- "keywords": array of strings (max 10)
- "entities": array of objects with:
  - "name": string
  - "entity_type": string (optional)
  - "entity_id": number (optional)
  - "confidence": number between 0 and 1 (optional)
- "importance": integer 0-10
- "confidence": integer 0-10
- "screenshot_ids": array of database screenshot IDs
- "event_time": timestamp in milliseconds (optional)

Edge schema:
- "from_index": integer (index into nodes)
- "to_index": integer (index into nodes)
- "edge_type": "event_produces_knowledge" | "event_updates_state" | "event_uses_procedure" | "event_suggests_plan"

Hard Rules:
1. Each VLM segment MUST produce at least one event node.
2. Each derived item MUST produce a separate node and an edge from its source event.
3. "screenshot_ids" MUST be database IDs (use Screenshot Mapping).
4. "event_time" should be the midpoint timestamp of the segment screenshots (milliseconds).
5. Do not output markdown, explanations, or extra text.`;

const TEXT_LLM_MERGE_SYSTEM_PROMPT = `You are a top AI analyst and information integration expert.

Task:
Merge two context nodes of the SAME kind into one coherent node.

Core Principles:
1. Faithfulness: Do not invent facts. Only use information present in the inputs.
2. Content Fusion: Integrate complementary details into a single coherent title/summary; avoid redundant phrasing.
3. Searchability: Use concrete identifiers (file names, tickets, commands, UI labels) when present.
4. De-duplication: Keywords and entities must be deduplicated.

Output Format:
Return ONLY valid JSON object with fields:
- title (<= 100 chars)
- summary (<= 200 chars)
- keywords (string[], max 10)
- entities (array of objects with name, entity_type?, entity_id?, confidence?)

Do not output markdown or extra text.`;

const TextLLMMergeResultSchema = z.object({
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(200),
  keywords: z.array(z.string()).max(10).default([]),
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        entity_id: z.number().int().positive().optional(),
        entity_type: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
      })
    )
    .default([]),
});

type TextLLMMergeResult = z.infer<typeof TextLLMMergeResultSchema>;

// ============================================================================
// TextLLMProcessor Class
// ============================================================================

/**
 * TextLLMProcessor expands VLM Index results into storable context nodes
 */
export class TextLLMProcessor {
  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Expand VLM Index result to context nodes and persist to database
   *
   * This is the main entry point that:
   * 1. Builds evidence packs from batch screenshots
   * 2. Calls Text LLM to expand segments
   * 3. Processes merge hints (NEW vs MERGE)
   * 4. Writes nodes, edges, and screenshot links to ContextGraphService
   *
   * @param vlmIndex - VLM Index result from VLMProcessor
   * @param batch - Batch containing screenshots and metadata
   * @returns Expand result with created node IDs
   */
  async expandToNodes(vlmIndex: VLMIndexResult, batch: Batch): Promise<ExpandResult> {
    logger.info(
      {
        batchId: batch.batchId,
        segmentCount: vlmIndex.segments.length,
        screenshotCount: batch.screenshots.length,
      },
      "Expanding VLM Index to context nodes"
    );

    try {
      // Build evidence packs from VLM screenshots output
      const evidencePacks = this.buildEvidencePacks(vlmIndex, batch);

      // Convert segments to pending nodes (without LLM call for now - direct conversion)
      let pendingNodes: PendingNode[];
      try {
        const rawExpansion = await this.callTextLLMForExpansion(vlmIndex, batch, evidencePacks);
        const parsed = parseTextLLMExpandResult(rawExpansion);
        if (!parsed.success || !parsed.data) {
          throw new Error(
            `Text LLM expand schema validation failed: ${parsed.error?.message ?? "unknown error"}`
          );
        }
        pendingNodes = this.convertTextLLMExpandResultToPendingNodes(parsed.data);
      } catch (error) {
        logger.warn(
          {
            batchId: batch.batchId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Text LLM expansion failed; falling back to direct conversion"
        );

        // Record failure for circuit breaker
        aiFailureCircuitBreaker.recordFailure("text", error);

        pendingNodes = this.convertSegmentsToPendingNodes(vlmIndex, batch, evidencePacks);
      }

      // Process merge hints and determine thread IDs
      const processedNodes = await this.processMergeHints(pendingNodes, vlmIndex.segments, batch);

      // Write to database
      const nodeIds = await this.persistNodes(processedNodes);

      const threadIds = [
        ...new Set(processedNodes.filter((n) => n.threadId).map((n) => n.threadId!)),
      ];

      logger.info(
        {
          batchId: batch.batchId,
          nodeCount: nodeIds.length,
          threadCount: threadIds.length,
        },
        "Successfully expanded VLM Index to context nodes"
      );

      return {
        nodeIds,
        threadIds,
        success: true,
      };
    } catch (error) {
      logger.error(
        {
          batchId: batch.batchId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to expand VLM Index"
      );

      return {
        nodeIds: [],
        threadIds: [],
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute merge of two context nodes
   *
   * Merges newNode into existingNode while:
   * - Preserving merged_from_ids
   * - Keeping all screenshot links
   * - Combining keywords and entities
   *
   * @param newNode - New node to merge
   * @param existingNode - Existing node to merge into
   * @returns Merged node result
   */
  async executeMerge(
    newNode: ExpandedContextNode,
    existingNode: ExpandedContextNode
  ): Promise<MergeResult> {
    if (newNode.kind !== existingNode.kind) {
      throw new Error(
        `Cannot merge nodes of different kinds: ${existingNode.kind} vs ${newNode.kind}`
      );
    }

    const mergeText = (a: string, b: string, maxLen: number): string => {
      const aTrim = a.trim();
      const bTrim = b.trim();
      if (!aTrim) return bTrim;
      if (!bTrim) return aTrim;
      const aLower = aTrim.toLowerCase();
      const bLower = bTrim.toLowerCase();
      if (aLower.includes(bLower)) return aTrim;
      if (bLower.includes(aLower)) return bTrim;

      const combined = `${aTrim} / ${bTrim}`;
      if (combined.length <= maxLen) return combined;

      const leftBudget = Math.max(0, Math.floor(maxLen * 0.6));
      const rightBudget = Math.max(0, maxLen - leftBudget - 3);
      const left = aTrim.slice(0, leftBudget).trimEnd();
      const right = bTrim.slice(0, rightBudget).trimEnd();
      const stitched = right ? `${left} / ${right}` : left;
      if (stitched.length <= maxLen) return stitched;
      return stitched.slice(0, Math.max(0, maxLen - 3)) + "...";
    };

    const mergeKeywords = (a: string[], b: string[], max: number): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const kw of [...a, ...b]) {
        const trimmed = kw.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= max) break;
      }
      return out;
    };

    // Combine keywords (unique, preserve order)
    const combinedKeywords = mergeKeywords(existingNode.keywords, newNode.keywords, 10);

    // Combine entities (unique by normalized name, preserve order, keep richer metadata)
    const entityMap = new Map<string, EntityRef>();
    const entityOrder: string[] = [];
    for (const entity of [...existingNode.entities, ...newNode.entities]) {
      const key = entity.name.trim().toLowerCase();
      if (!key) continue;
      const existing = entityMap.get(key);
      if (!existing) {
        entityMap.set(key, entity);
        entityOrder.push(key);
        continue;
      }

      const merged: EntityRef = {
        ...existing,
        entityId: existing.entityId ?? entity.entityId,
        entityType: existing.entityType ?? entity.entityType,
        confidence:
          existing.confidence === undefined
            ? entity.confidence
            : entity.confidence === undefined
              ? existing.confidence
              : Math.max(existing.confidence, entity.confidence),
      };
      entityMap.set(key, merged);
    }
    const combinedEntities = entityOrder.map((k) => entityMap.get(k)!).filter(Boolean);

    // Combine screenshot IDs (unique, stable order)
    const combinedScreenshotIds = [
      ...new Set([...existingNode.screenshotIds, ...newNode.screenshotIds]),
    ].sort((a, b) => a - b);

    // Track merged IDs (unique, preserve order)
    const mergedFromIds = [
      ...new Set([...(existingNode.mergedFromIds || []), ...(newNode.mergedFromIds || [])]),
    ];

    const mergedNode: ExpandedContextNode = {
      kind: existingNode.kind,
      threadId: existingNode.threadId ?? newNode.threadId,
      title: mergeText(existingNode.title, newNode.title, 100),
      summary: mergeText(existingNode.summary, newNode.summary, 200),
      keywords: combinedKeywords,
      entities: combinedEntities,
      importance: Math.max(existingNode.importance, newNode.importance),
      confidence: Math.max(existingNode.confidence, newNode.confidence),
      mergedFromIds: mergedFromIds.length > 0 ? mergedFromIds : undefined,
      screenshotIds: combinedScreenshotIds,
      eventTime: existingNode.eventTime ?? newNode.eventTime,
    };

    try {
      const llmMerged = await this.callTextLLMForMerge(existingNode, newNode);
      const llmEntities: EntityRef[] = llmMerged.entities.map((e) => ({
        name: e.name,
        entityId: e.entity_id,
        entityType: e.entity_type,
        confidence: e.confidence,
      }));

      const llmKeywordList = llmMerged.keywords ?? [];
      mergedNode.title = llmMerged.title;
      mergedNode.summary = llmMerged.summary;
      mergedNode.keywords = mergeKeywords(llmKeywordList, combinedKeywords, 10);

      const mergedEntityMap = new Map<string, EntityRef>();
      const mergedEntityOrder: string[] = [];
      for (const entity of [...llmEntities, ...combinedEntities]) {
        const key = entity.name.trim().toLowerCase();
        if (!key) continue;
        const existing = mergedEntityMap.get(key);
        if (!existing) {
          mergedEntityMap.set(key, entity);
          mergedEntityOrder.push(key);
          continue;
        }
        const merged: EntityRef = {
          ...existing,
          entityId: existing.entityId ?? entity.entityId,
          entityType: existing.entityType ?? entity.entityType,
          confidence:
            existing.confidence === undefined
              ? entity.confidence
              : entity.confidence === undefined
                ? existing.confidence
                : Math.max(existing.confidence, entity.confidence),
        };
        mergedEntityMap.set(key, merged);
      }
      mergedNode.entities = mergedEntityOrder.map((k) => mergedEntityMap.get(k)!).filter(Boolean);

      logger.debug(
        { kind: existingNode.kind, title: mergedNode.title },
        "Text LLM merge succeeded"
      );
    } catch (error) {
      logger.debug(
        { kind: existingNode.kind, error: error instanceof Error ? error.message : String(error) },
        "Text LLM merge skipped/failed; using heuristic merge"
      );
    }

    return {
      mergedNode,
      mergedFromIds,
    };
  }

  /**
   * Build expand prompt for Text LLM
   *
   * @param vlmIndex - VLM Index result
   * @param batch - Batch with screenshots
   * @param evidencePacks - Evidence packs for screenshots
   * @returns Formatted prompt string
   */
  buildExpandPrompt(vlmIndex: VLMIndexResult, batch: Batch, evidencePacks: EvidencePack[]): string {
    const segmentsJson = JSON.stringify(vlmIndex.segments, null, 2);
    const evidenceJson = JSON.stringify(evidencePacks, null, 2);

    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const utcOffsetMinutes = -now.getTimezoneOffset();
    const offsetSign = utcOffsetMinutes >= 0 ? "+" : "-";
    const offsetAbs = Math.abs(utcOffsetMinutes);
    const offsetHours = String(Math.floor(offsetAbs / 60)).padStart(2, "0");
    const offsetMins = String(offsetAbs % 60).padStart(2, "0");
    const utcOffset = `UTC${offsetSign}${offsetHours}:${offsetMins}`;
    const localTime = now.toLocaleString("sv-SE", { timeZone, hour12: false });

    // Build screenshot ID mapping (screen_id -> database ID)
    const screenshotMapping = batch.screenshots.map((s, idx) => ({
      screen_id: idx + 1,
      database_id: s.id,
      ts: s.ts,
      source_key: s.sourceKey,
      app_hint: s.meta.appHint,
      window_title: s.meta.windowTitle,
    }));

    return `Please expand the following VLM Index into storable context nodes.

## Current User Time Context (for relative time interpretation)
- local_time: ${localTime}
- time_zone: ${timeZone}
- utc_offset: ${utcOffset}
- now_utc: ${now.toISOString()}

## VLM Segments
${segmentsJson}

## Screenshot Mapping (screen_id -> database_id)
${JSON.stringify(screenshotMapping, null, 2)}

## Evidence Packs
${evidenceJson}

## Batch Info
- Batch ID: ${batch.batchId}
- Source Key: ${batch.sourceKey}
- Time Range: ${new Date(batch.tsStart).toISOString()} to ${new Date(batch.tsEnd).toISOString()}

## VLM Entities (batch-level candidates)
${JSON.stringify(vlmIndex.entities ?? [], null, 2)}

## Instructions
1. Produce at least one event node for each segment.
2. For each derived item (knowledge/state/procedure/plan), create a separate node and an edge from its source event.
3. Convert segment screen_ids (1-based indexes) to database screenshot_ids using the Screenshot Mapping section.
4. Use Evidence Packs (OCR + UI snippets) only to enrich specificity; do not invent any facts.
5. Output must be strict JSON only (no markdown, no code fences, no extra commentary).

Return the JSON now:`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build evidence packs from VLM screenshots output and batch
   */
  private buildEvidencePacks(vlmIndex: VLMIndexResult, batch: Batch): EvidencePack[] {
    const packs: EvidencePack[] = [];

    for (const screenshot of batch.screenshots) {
      // Find VLM screenshot data if available
      const vlmScreenshot = vlmIndex.screenshots?.find((s) => s.screenshot_id === screenshot.id);

      packs.push({
        screenshotId: screenshot.id,
        appHint: screenshot.meta.appHint,
        windowTitle: screenshot.meta.windowTitle,
        ocrText: vlmScreenshot?.ocr_text,
        uiTextSnippets: vlmScreenshot?.ui_text_snippets,
      });
    }

    return packs;
  }

  private convertTextLLMExpandResultToPendingNodes(result: TextLLMExpandResult): PendingNode[] {
    const pendingNodes: PendingNode[] = result.nodes.map((node) => {
      const entities: EntityRef[] = (node.entities ?? []).map((e) => ({
        name: e.name,
        entityId: e.entity_id,
        entityType: e.entity_type,
        confidence: e.confidence,
      }));

      return {
        kind: node.kind,
        threadId: node.kind === "event" ? node.thread_id : undefined,
        title: node.title,
        summary: node.summary,
        keywords: node.keywords ?? [],
        entities,
        importance: node.importance,
        confidence: node.confidence,
        screenshotIds: node.screenshot_ids ?? [],
        eventTime: node.event_time,
      };
    });

    const sourceEventIndexByNodeIndex = new Map<number, number>();
    for (const edge of result.edges ?? []) {
      const fromIndex = edge.from_index;
      const toIndex = edge.to_index;
      const fromNode = pendingNodes[fromIndex];
      const toNode = pendingNodes[toIndex];
      if (!fromNode || !toNode) continue;
      if (fromNode.kind !== "event") continue;
      if (toNode.kind === "event") continue;
      sourceEventIndexByNodeIndex.set(toIndex, fromIndex);
    }

    for (let i = 0; i < pendingNodes.length; i++) {
      const node = pendingNodes[i];
      if (node.kind === "event") continue;
      let sourceEventIndex = sourceEventIndexByNodeIndex.get(i);
      if (sourceEventIndex === undefined) {
        for (let j = i - 1; j >= 0; j--) {
          if (pendingNodes[j]?.kind === "event") {
            sourceEventIndex = j;
            break;
          }
        }
      }

      if (sourceEventIndex === undefined) {
        const firstEventIndex = pendingNodes.findIndex((n) => n.kind === "event");
        sourceEventIndex = firstEventIndex >= 0 ? firstEventIndex : undefined;
      }

      if (sourceEventIndex === undefined) {
        throw new Error("Text LLM expand output has derived nodes but no event nodes");
      }

      node.sourceEventIndex = sourceEventIndex;
    }

    return pendingNodes;
  }

  /**
   * Convert VLM segments directly to pending nodes (without additional LLM call)
   */
  private convertSegmentsToPendingNodes(
    vlmIndex: VLMIndexResult,
    batch: Batch,
    evidencePacks: EvidencePack[]
  ): PendingNode[] {
    const pendingNodes: PendingNode[] = [];

    // Build screen_id to database_id mapping
    const screenIdToDbId = new Map<number, number>();
    batch.screenshots.forEach((s, idx) => {
      screenIdToDbId.set(idx + 1, s.id);
    });

    for (const segment of vlmIndex.segments) {
      // Convert screen_ids to database IDs
      const screenshotIds = segment.screen_ids
        .map((screenId) => screenIdToDbId.get(screenId))
        .filter((id): id is number => id !== undefined);

      // Calculate event time as midpoint of screenshots
      const segmentScreenshots = batch.screenshots.filter((s) => screenshotIds.includes(s.id));
      const eventTime =
        segmentScreenshots.length > 0
          ? Math.floor(
              (segmentScreenshots[0].ts + segmentScreenshots[segmentScreenshots.length - 1].ts) / 2
            )
          : batch.tsStart;

      // Extract entities from VLM batch-level entities and segment keywords
      const entities: EntityRef[] = vlmIndex.entities.slice(0, 10).map((name) => ({
        name,
        entityType: "unknown",
      }));

      // Enrich summary with evidence
      const enrichedSummary = this.enrichSummaryWithEvidence(
        segment.event.summary,
        evidencePacks.filter((ep) => screenshotIds.includes(ep.screenshotId))
      );

      // Create event node (index in array)
      const eventNodeIndex = pendingNodes.length;
      pendingNodes.push({
        kind: "event",
        title: segment.event.title,
        summary: enrichedSummary,
        keywords: segment.keywords || [],
        entities,
        importance: segment.event.importance,
        confidence: segment.event.confidence,
        screenshotIds,
        eventTime,
      });

      // Create derived nodes
      this.addDerivedNodes(
        pendingNodes,
        segment.derived.knowledge,
        "knowledge",
        eventNodeIndex,
        screenshotIds
      );
      this.addDerivedNodes(
        pendingNodes,
        segment.derived.state,
        "state_snapshot",
        eventNodeIndex,
        screenshotIds
      );
      this.addDerivedNodes(
        pendingNodes,
        segment.derived.procedure,
        "procedure",
        eventNodeIndex,
        screenshotIds
      );
      this.addDerivedNodes(
        pendingNodes,
        segment.derived.plan,
        "plan",
        eventNodeIndex,
        screenshotIds
      );
    }

    return pendingNodes;
  }

  /**
   * Add derived nodes to pending nodes array
   */
  private addDerivedNodes(
    pendingNodes: PendingNode[],
    items: DerivedItem[],
    kind: ContextKind,
    sourceEventIndex: number,
    screenshotIds: number[]
  ): void {
    for (const item of items) {
      // Build summary including steps for procedures
      let summary = item.summary;
      if (kind === "procedure" && item.steps && item.steps.length > 0) {
        summary = `${item.summary} Steps: ${item.steps.join(" → ")}`;
        if (summary.length > 200) {
          summary = summary.substring(0, 197) + "...";
        }
      }

      pendingNodes.push({
        kind,
        title: item.title,
        summary,
        keywords: [],
        entities: [],
        importance: 5,
        confidence: 5,
        screenshotIds,
        sourceEventIndex,
      });
    }
  }

  /**
   * Enrich summary with evidence from OCR and UI snippets
   */
  private enrichSummaryWithEvidence(summary: string, evidencePacks: EvidencePack[]): string {
    // Extract key snippets from evidence
    const keySnippets: string[] = [];

    for (const pack of evidencePacks) {
      if (pack.uiTextSnippets) {
        // Take first 2 high-value snippets
        keySnippets.push(...pack.uiTextSnippets.slice(0, 2));
      }
    }

    if (keySnippets.length === 0) {
      return summary;
    }

    // Append key evidence to summary if it fits
    const evidenceNote = ` [Evidence: ${keySnippets.slice(0, 2).join("; ")}]`;
    if (summary.length + evidenceNote.length <= 200) {
      return summary + evidenceNote;
    }

    return summary;
  }

  /**
   * Process merge hints and assign thread IDs
   */
  private async processMergeHints(
    pendingNodes: PendingNode[],
    segments: VLMSegment[],
    batch: Batch
  ): Promise<PendingNode[]> {
    const processedNodes = [...pendingNodes];

    const screenIdToDbId = new Map<number, number>();
    batch.screenshots.forEach((s, idx) => {
      screenIdToDbId.set(idx + 1, s.id);
    });

    const segmentDbScreenshotIds = segments.map((segment) =>
      segment.screen_ids
        .map((screenId) => screenIdToDbId.get(screenId))
        .filter((id): id is number => id !== undefined)
    );

    const threadIdBySegmentIndex = new Map<number, string>();
    const getThreadIdForSegment = (segment: VLMSegment, index: number): string => {
      const existing = threadIdBySegmentIndex.get(index);
      if (existing) return existing;
      const mergeHint = segment.merge_hint;
      const threadId =
        mergeHint.decision === "MERGE" && mergeHint.thread_id
          ? mergeHint.thread_id
          : this.generateThreadId();
      threadIdBySegmentIndex.set(index, threadId);
      return threadId;
    };

    const usedSequentialSegmentIndexes = new Set<number>();
    let nextSequentialSegmentIndex = 0;

    for (let i = 0; i < processedNodes.length; i++) {
      const node = processedNodes[i];

      // Only event nodes need thread assignment
      if (node.kind !== "event") {
        continue;
      }

      let matchedSegmentIndex: number | undefined;
      if (node.screenshotIds.length > 0) {
        let bestIndex = -1;
        let bestOverlap = 0;
        for (let segIdx = 0; segIdx < segmentDbScreenshotIds.length; segIdx++) {
          const segIds = segmentDbScreenshotIds[segIdx];
          if (!segIds || segIds.length === 0) continue;
          const segIdSet = new Set(segIds);
          let overlap = 0;
          for (const sid of node.screenshotIds) {
            if (segIdSet.has(sid)) overlap++;
          }
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestIndex = segIdx;
          }
        }
        if (bestIndex >= 0 && bestOverlap > 0) {
          matchedSegmentIndex = bestIndex;
        }
      }

      if (matchedSegmentIndex === undefined) {
        while (usedSequentialSegmentIndexes.has(nextSequentialSegmentIndex)) {
          nextSequentialSegmentIndex++;
        }
        if (nextSequentialSegmentIndex < segments.length) {
          matchedSegmentIndex = nextSequentialSegmentIndex;
          usedSequentialSegmentIndexes.add(nextSequentialSegmentIndex);
          nextSequentialSegmentIndex++;
        }
      }

      if (matchedSegmentIndex === undefined) {
        node.threadId = this.generateThreadId();
        logger.debug(
          { threadId: node.threadId, nodeTitle: node.title },
          "Creating new thread for event"
        );
        continue;
      }

      const segment = segments[matchedSegmentIndex];
      const mergeHint = segment?.merge_hint;
      if (!segment || !mergeHint) {
        node.threadId = this.generateThreadId();
        logger.debug(
          { threadId: node.threadId, nodeTitle: node.title },
          "Creating new thread for event"
        );
        continue;
      }

      node.threadId = getThreadIdForSegment(segment, matchedSegmentIndex);

      if (mergeHint.decision === "MERGE" && mergeHint.thread_id) {
        logger.debug(
          { threadId: mergeHint.thread_id, nodeTitle: node.title },
          "Merging event into existing thread"
        );
      } else {
        logger.debug(
          { threadId: node.threadId, nodeTitle: node.title },
          "Creating new thread for event"
        );
      }
    }

    return processedNodes;
  }

  /**
   * Generate a unique thread ID
   */
  private generateThreadId(): string {
    return `thread_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  /**
   * Persist nodes to database via ContextGraphService
   *
   * Creates nodes, edges, and screenshot links in proper order
   */
  private async persistNodes(pendingNodes: PendingNode[]): Promise<string[]> {
    const nodeIds: string[] = [];
    const nodeIdByIndex = new Map<number, string>();

    // First pass: create all nodes
    for (let i = 0; i < pendingNodes.length; i++) {
      const node = pendingNodes[i];

      // Determine source event ID for derived nodes
      let sourceEventId: number | undefined;
      if (node.sourceEventIndex !== undefined) {
        const sourceNodeId = nodeIdByIndex.get(node.sourceEventIndex);
        if (sourceNodeId) {
          sourceEventId = parseInt(sourceNodeId, 10);
        }
      }

      const input: CreateNodeInput = {
        kind: node.kind,
        threadId: node.threadId,
        title: node.title,
        summary: node.summary,
        keywords: node.keywords,
        entities: node.entities,
        importance: node.importance,
        confidence: node.confidence,
        eventTime: node.eventTime,
        screenshotIds: node.screenshotIds,
        sourceEventId,
      };

      try {
        const nodeId = await contextGraphService.createNode(input);
        nodeIds.push(nodeId);
        nodeIdByIndex.set(i, nodeId);

        // Sync entity mentions for event nodes
        if (node.kind === "event") {
          try {
            await entityService.syncEventEntityMentions(parseInt(nodeId, 10), node.entities, "llm");
          } catch (err) {
            logger.warn({ nodeId, error: String(err) }, "Failed to sync entity mentions for node");
          }
        }

        logger.debug(
          {
            nodeId,
            kind: node.kind,
            title: node.title,
            screenshotCount: node.screenshotIds.length,
          },
          "Created context node"
        );
      } catch (error) {
        logger.error(
          {
            kind: node.kind,
            title: node.title,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to create context node"
        );
        throw error;
      }
    }

    return nodeIds;
  }

  /**
   * Call Text LLM to expand VLM Index (optional enhancement)
   *
   * This method can be used for more sophisticated expansion
   * when direct conversion is not sufficient.
   */
  protected async callTextLLMForExpansion(
    vlmIndex: VLMIndexResult,
    batch: Batch,
    evidencePacks: EvidencePack[]
  ): Promise<unknown> {
    const aiService = AISDKService.getInstance();

    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    const prompt = this.buildExpandPrompt(vlmIndex, batch, evidencePacks);

    const { text: rawText, usage } = await generateText({
      model: aiService.getTextClient(),
      system: TEXT_LLM_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    llmUsageService.logEvent({
      ts: Date.now(),
      capability: "text",
      operation: "text_expand",
      status: "succeeded",
      model: aiService.getTextModelName(),
      provider: "openai_compatible",
      totalTokens: usage?.totalTokens ?? 0,
      usageStatus: usage ? "present" : "missing",
    });

    // Parse response
    return this.parseTextLLMResponse(rawText);
  }

  /**
   * Parse Text LLM response
   */
  private parseTextLLMResponse(rawText: string): unknown {
    let jsonStr = rawText.trim();

    // Remove markdown code block if present
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Try to find JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in Text LLM response");
    }

    return JSON.parse(jsonMatch[0]);
  }

  private buildMergePrompt(
    existingNode: ExpandedContextNode,
    newNode: ExpandedContextNode
  ): string {
    const toLLMNode = (node: ExpandedContextNode) => ({
      kind: node.kind,
      thread_id: node.threadId,
      title: node.title,
      summary: node.summary,
      keywords: node.keywords,
      entities: node.entities.map((e) => ({
        name: e.name,
        entity_id: e.entityId,
        entity_type: e.entityType,
        confidence: e.confidence,
      })),
      importance: node.importance,
      confidence: node.confidence,
      screenshot_ids: node.screenshotIds,
      event_time: node.eventTime,
    });

    return `Merge the following two context nodes into one.

## Existing Node
${JSON.stringify(toLLMNode(existingNode), null, 2)}

## New Node
${JSON.stringify(toLLMNode(newNode), null, 2)}

Return the JSON object now:`;
  }

  private async callTextLLMForMerge(
    existingNode: ExpandedContextNode,
    newNode: ExpandedContextNode
  ): Promise<TextLLMMergeResult> {
    const aiService = AISDKService.getInstance();
    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    const prompt = this.buildMergePrompt(existingNode, newNode);
    const { text: rawText, usage } = await generateText({
      model: aiService.getTextClient(),
      system: TEXT_LLM_MERGE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    // Log usage
    llmUsageService.logEvent({
      ts: Date.now(),
      capability: "text",
      operation: "text_merge",
      status: "succeeded",
      model: aiService.getTextModelName(),
      provider: "openai_compatible",
      totalTokens: usage?.totalTokens ?? 0,
      usageStatus: usage ? "present" : "missing",
    });

    const parsed = this.parseTextLLMResponse(rawText);
    const validated = TextLLMMergeResultSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Text LLM merge schema validation failed: ${validated.error.message}`);
    }
    return validated.data;
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const textLLMProcessor = new TextLLMProcessor();

/**
 * Process a batch through Text LLM expansion
 *
 * Convenience function that wraps TextLLMProcessor.expandToNodes
 */
export async function expandVLMIndexToNodes(
  vlmIndex: VLMIndexResult,
  batch: Batch
): Promise<ExpandResult> {
  return textLLMProcessor.expandToNodes(vlmIndex, batch);
}
