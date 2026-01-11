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
import { generateObject } from "ai";

import { AISDKService } from "../ai-sdk-service";
import { getLogger } from "../logger";
import { contextGraphService, type CreateNodeInput } from "./context-graph-service";
import { entityService } from "./entity-service";
import { llmUsageService } from "../llm-usage-service";
import { promptTemplates } from "./prompt-templates";
import {
  TextLLMExpandResultSchema,
  TextLLMExpandResultProcessedSchema,
  TextLLMMergeResultSchema,
  TextLLMMergeResultProcessedSchema,
} from "./schemas";

import type {
  VLMIndexResult,
  VLMSegment,
  DerivedItem,
  TextLLMExpandResult,
  TextLLMMergeResult,
} from "./schemas";
import type {
  Batch,
  ExpandedContextNode,
  EntityRef,
  ContextKind,
  EvidencePack as EvidencePackType,
} from "./types";
import { processingConfig } from "./config";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { aiRuntimeService } from "../ai-runtime-service";

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
  segmentId?: string;
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
// TextLLMProcessor Class
// ============================================================================

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
        pendingNodes = this.convertTextLLMExpandResultToPendingNodes(
          await this.callTextLLMForExpansion(vlmIndex, batch, evidencePacks),
          batch
        );
      } catch (error) {
        logger.warn(
          {
            batchId: batch.batchId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Text LLM expansion failed; falling back to direct conversion"
        );

        // Record failure for circuit breaker
        aiRuntimeService.recordFailure("text", error);

        pendingNodes = this.convertSegmentsToPendingNodes(vlmIndex, batch, evidencePacks);
      }

      // Process merge hints and determine thread IDs
      const processedNodes = await this.processMergeHints(pendingNodes, vlmIndex.segments, batch);

      // Write to database
      const nodeIds = await this.persistNodes(processedNodes, batch);

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
        entityId: e.entityId,
        entityType: e.entityType,
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

    return promptTemplates.getTextLLMExpandUserPrompt({
      localTime,
      timeZone,
      utcOffset,
      now,
      segmentsJson,
      screenshotMappingJson: JSON.stringify(screenshotMapping, null, 2),
      evidenceJson,
      batchId: batch.batchId,
      sourceKey: batch.sourceKey,
      batchTimeRange: `${new Date(batch.tsStart).toISOString()} to ${new Date(batch.tsEnd).toISOString()}`,
      vlmEntitiesJson: JSON.stringify(vlmIndex.entities ?? [], null, 2),
    });
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
        uiTextSnippets: vlmScreenshot?.ui_text_snippets?.filter(
          (v): v is string => typeof v === "string"
        ),
      });
    }

    return packs;
  }

  private convertTextLLMExpandResultToPendingNodes(
    result: TextLLMExpandResult,
    batch: Batch
  ): PendingNode[] {
    const screenshotTsMap = new Map<number, number>(batch.screenshots.map((s) => [s.id, s.ts]));

    const pendingNodes: PendingNode[] = result.nodes.map((node) => {
      const entities: EntityRef[] = (node.entities ?? []).map((e) => ({
        name: e.name,
        entityId: e.entityId,
        entityType: e.entityType,
        confidence: e.confidence,
      }));

      let eventTime = node.event_time;

      // Auto-fill eventTime for Event nodes if missing
      if (node.kind === "event" && eventTime === undefined) {
        if (node.screenshot_ids && node.screenshot_ids.length > 0) {
          const timestamps = node.screenshot_ids
            .map((id) => screenshotTsMap.get(id))
            .filter((ts): ts is number => ts !== undefined);

          if (timestamps.length > 0) {
            // Midpoint of screenshots
            eventTime = Math.floor((Math.min(...timestamps) + Math.max(...timestamps)) / 2);
          }
        }

        // Final fallback if still empty
        if (eventTime === undefined) {
          eventTime = Math.floor((batch.tsStart + batch.tsEnd) / 2);
        }
      }

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
        eventTime,
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

      // Inherit eventTime if missing (derived nodes)
      if (node.eventTime === undefined && sourceEventIndex !== undefined) {
        node.eventTime = pendingNodes[sourceEventIndex].eventTime;
      }
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
        segmentId: segment.segment_id,
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
        screenshotIds,
        eventTime,
        segment.segment_id
      );
      this.addDerivedNodes(
        pendingNodes,
        segment.derived.state,
        "state_snapshot",
        eventNodeIndex,
        screenshotIds,
        eventTime,
        segment.segment_id
      );
      this.addDerivedNodes(
        pendingNodes,
        segment.derived.procedure,
        "procedure",
        eventNodeIndex,
        screenshotIds,
        eventTime,
        segment.segment_id
      );
      this.addDerivedNodes(
        pendingNodes,
        segment.derived.plan,
        "plan",
        eventNodeIndex,
        screenshotIds,
        eventTime,
        segment.segment_id
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
    screenshotIds: number[],
    eventTime: number,
    segmentId?: string
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
        segmentId,
        title: item.title,
        summary,
        keywords: [],
        entities: [],
        importance: 5,
        confidence: 5,
        screenshotIds,
        sourceEventIndex,
        eventTime,
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
        node.segmentId = undefined;
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
        node.segmentId = undefined;
        logger.debug(
          { threadId: node.threadId, nodeTitle: node.title },
          "Creating new thread for event"
        );
        continue;
      }

      node.threadId = getThreadIdForSegment(segment, matchedSegmentIndex);
      node.segmentId = segment.segment_id;

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
  private async persistNodes(pendingNodes: PendingNode[], batch: Batch): Promise<string[]> {
    const nodeIds: string[] = [];
    const nodeIdByIndex = new Map<number, string>();

    const sortedScreenshotKey = (ids: number[]): string => {
      const sorted = [...ids].sort((a, b) => a - b);
      return sorted.join(",");
    };

    const derivedOrdinalByIndex = new Map<number, number>();
    const derivedIndexesByGroup = new Map<string, number[]>();
    for (let i = 0; i < pendingNodes.length; i++) {
      const node = pendingNodes[i];
      if (node.kind === "event") continue;
      const key = `${node.sourceEventIndex ?? -1}|${node.kind}`;
      const arr = derivedIndexesByGroup.get(key) ?? [];
      arr.push(i);
      derivedIndexesByGroup.set(key, arr);
    }

    for (const indexes of derivedIndexesByGroup.values()) {
      indexes.sort((a, b) => {
        const na = pendingNodes[a];
        const nb = pendingNodes[b];
        const byTitle = na.title.toLowerCase().localeCompare(nb.title.toLowerCase());
        if (byTitle !== 0) return byTitle;
        return a - b;
      });
      for (let ordinal = 1; ordinal <= indexes.length; ordinal++) {
        derivedOrdinalByIndex.set(indexes[ordinal - 1], ordinal);
      }
    }

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

      const sourceEventNode =
        node.sourceEventIndex !== undefined ? pendingNodes[node.sourceEventIndex] : undefined;

      const baseKey =
        node.kind === "event"
          ? `ss:${sortedScreenshotKey(node.screenshotIds)}`
          : `ss:${sortedScreenshotKey(sourceEventNode?.screenshotIds ?? node.screenshotIds)}`;

      const ordinal = node.kind === "event" ? 0 : (derivedOrdinalByIndex.get(i) ?? 0);

      const originKey =
        node.kind === "event"
          ? `ctx_node:${batch.idempotencyKey}:${baseKey}:event`
          : `ctx_node:${batch.idempotencyKey}:${baseKey}:${node.kind}:${ordinal}`;

      const input: CreateNodeInput = {
        kind: node.kind,
        threadId: node.threadId,
        originKey,
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
  ): Promise<TextLLMExpandResult> {
    const aiService = AISDKService.getInstance();

    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    const prompt = this.buildExpandPrompt(vlmIndex, batch, evidencePacks);
    const modelName = aiService.getTextModelName();

    // Acquire global text semaphore
    const release = await aiRuntimeService.acquire("text");

    // Start timing AFTER acquiring semaphore so durationMs reflects actual API call time
    const startTime = Date.now();

    // Setup timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);

    try {
      const response = await generateObject({
        model: aiService.getTextClient(),
        system: promptTemplates.getTextLLMExpandSystemPrompt(),
        schema: TextLLMExpandResultSchema,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        abortSignal: controller.signal,
      });

      const result = TextLLMExpandResultProcessedSchema.parse(response.object);
      const durationMs = Date.now() - startTime;

      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "text_expand",
        status: "succeeded",
        model: modelName,
        provider: "openai_compatible",
        totalTokens: response.usage?.totalTokens ?? 0,
        usageStatus: response.usage ? "present" : "missing",
      });

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_expand",
        model: modelName,
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(result, null, 2),
      });

      aiRuntimeService.recordSuccess("text");

      return result as TextLLMExpandResult;
    } catch (err) {
      const durationMs = Date.now() - startTime;

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_expand",
        model: modelName,
        durationMs,
        status: "failed",
        errorPreview: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });

      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          batchId: batch.batchId,
        },
        "Text LLM expansion generateObject call failed"
      );

      aiRuntimeService.recordFailure("text", err);
      throw err;
    } finally {
      clearTimeout(timeoutId);
      release();
    }
  }

  /**
   * Build merge prompt for Text LLM
   */
  private buildMergePrompt(
    existingNode: ExpandedContextNode,
    newNode: ExpandedContextNode
  ): string {
    const toLLMNode = (node: ExpandedContextNode) => ({
      kind: node.kind,
      title: node.title,
      summary: node.summary,
      keywords: node.keywords,
      entities: node.entities,
      importance: node.importance,
      confidence: node.confidence,
      screenshot_ids: node.screenshotIds,
      event_time: node.eventTime,
    });

    return promptTemplates.getTextLLMMergeUserPrompt({
      existingNodeJson: JSON.stringify(toLLMNode(existingNode), null, 2),
      newNodeJson: JSON.stringify(toLLMNode(newNode), null, 2),
    });
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
    const modelName = aiService.getTextModelName();

    // Acquire global text semaphore
    const semaphoreStart = Date.now();
    const release = await aiRuntimeService.acquire("text");
    const semaphoreWaitMs = Date.now() - semaphoreStart;
    logger.debug(
      { sourceId: existingNode.id, targetId: newNode.id, waitMs: semaphoreWaitMs },
      "Text LLM merge semaphore acquired"
    );

    // Start timing AFTER acquiring semaphore so durationMs reflects actual API call time
    const startTime = Date.now();

    // Setup timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);

    try {
      const response = await generateObject({
        model: aiService.getTextClient(),
        system: promptTemplates.getTextLLMMergeSystemPrompt(),
        schema: TextLLMMergeResultSchema,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        providerOptions: {
          mnemora: {
            thinking: {
              type: "disabled",
            },
          },
        },
        abortSignal: controller.signal,
      });

      const result = TextLLMMergeResultProcessedSchema.parse(response.object);
      const durationMs = Date.now() - startTime;

      // Log usage
      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "text_merge",
        status: "succeeded",
        model: modelName,
        provider: "openai_compatible",
        totalTokens: response.usage?.totalTokens ?? 0,
        usageStatus: response.usage ? "present" : "missing",
      });

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_merge",
        model: modelName,
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(result, null, 2),
      });

      aiRuntimeService.recordSuccess("text");

      return result as TextLLMMergeResult;
    } catch (err) {
      const durationMs = Date.now() - startTime;

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_merge",
        model: modelName,
        durationMs,
        status: "failed",
        errorPreview: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });

      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          sourceId: existingNode.id,
          targetId: newNode.id,
        },
        "Text LLM merge generateObject call failed"
      );

      aiRuntimeService.recordFailure("text", err);
      throw err;
    } finally {
      clearTimeout(timeoutId);
      release();
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const textLLMProcessor = new TextLLMProcessor();
