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
 * Design reference: screenshot-process-v2.md Section 4.5 Text LLM 阶段
 * Requirements: Task 8 - Text LLM 处理器
 */

import crypto from "node:crypto";
import { generateText } from "ai";

import { AISDKService } from "../ai-sdk-service";
import { getLogger } from "../logger";
import { contextGraphService, type CreateNodeInput } from "./context-graph-service";
import type { VLMIndexResult, VLMSegment, DerivedItem } from "./schemas";
import type { Batch, ExpandedContextNode, EntityRef, ContextKind } from "./types";

const logger = getLogger("text-llm-processor");

// ============================================================================
// Types
// ============================================================================

/**
 * Evidence pack for a screenshot (minimal evidence for retrieval)
 */
export interface EvidencePack {
  screenshotId: number;
  appHint?: string;
  windowTitle?: string;
  ocrText?: string;
  uiTextSnippets?: string[];
}

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

const TEXT_LLM_SYSTEM_PROMPT = `You are an expert at expanding and enriching activity context from VLM analysis results.

Your task is to take VLM Index results and expand them into well-structured context nodes that can be stored and retrieved later.

## Input
You will receive:
1. VLM Index with segments (events and derived items)
2. Batch metadata (timestamps, source)
3. Evidence packs with OCR text and UI snippets

## Output Format
Return a JSON object with expanded nodes:
\`\`\`json
{
  "nodes": [
    {
      "kind": "event|knowledge|state_snapshot|procedure|plan",
      "thread_id": "string (for events only)",
      "title": "string (<=100 chars)",
      "summary": "string (<=200 chars)",
      "keywords": ["string"],
      "entities": [{"name": "string", "entityType": "person|project|app|org|repo|ticket"}],
      "importance": 0-10,
      "confidence": 0-10,
      "screenshot_ids": [1, 2, 3],
      "event_time": 1234567890000
    }
  ],
  "edges": [
    {
      "from_index": 0,
      "to_index": 1,
      "edge_type": "event_produces_knowledge|event_updates_state|event_uses_procedure|event_suggests_plan"
    }
  ]
}
\`\`\`

## Rules
1. Each VLM segment MUST produce at least one "event" node
2. Derived items (knowledge/state/procedure/plan) become separate nodes with edges to their source event
3. Use evidence from OCR text and UI snippets to enrich summaries
4. Keywords should be specific and searchable (5-10 per node)
5. Entities should be canonical names (people, projects, apps, tickets)
6. Event nodes must have thread_id (use provided or generate new)
7. screenshot_ids should reference the actual database IDs from the batch
8. event_time should be the midpoint timestamp of the segment's screenshots

## Quality Guidelines
- Summaries should be specific and actionable, not vague
- Include concrete details from the evidence (file names, issue IDs, etc.)
- Keywords should help future retrieval
- Entities should be normalized (e.g., "John Smith" not "john", "PROJ-123" not "the ticket")`;

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
      const pendingNodes = this.convertSegmentsToPendingNodes(vlmIndex, batch, evidencePacks);

      // Process merge hints and determine thread IDs
      const processedNodes = await this.processMergeHints(pendingNodes, vlmIndex.segments);

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
    // Combine keywords (unique)
    const combinedKeywords = [...new Set([...existingNode.keywords, ...newNode.keywords])].slice(
      0,
      10
    );

    // Combine entities (unique by name)
    const entityMap = new Map<string, EntityRef>();
    for (const entity of [...existingNode.entities, ...newNode.entities]) {
      if (!entityMap.has(entity.name)) {
        entityMap.set(entity.name, entity);
      }
    }
    const combinedEntities = Array.from(entityMap.values());

    // Combine screenshot IDs
    const combinedScreenshotIds = [
      ...new Set([...existingNode.screenshotIds, ...newNode.screenshotIds]),
    ];

    // Track merged IDs
    const mergedFromIds = [...(existingNode.mergedFromIds || []), ...(newNode.mergedFromIds || [])];

    // Use longer/better summary
    const summary =
      newNode.summary.length > existingNode.summary.length ? newNode.summary : existingNode.summary;

    const mergedNode: ExpandedContextNode = {
      kind: existingNode.kind,
      threadId: existingNode.threadId,
      title: existingNode.title, // Keep existing title
      summary,
      keywords: combinedKeywords,
      entities: combinedEntities,
      importance: Math.max(existingNode.importance, newNode.importance),
      confidence: Math.max(existingNode.confidence, newNode.confidence),
      mergedFromIds: mergedFromIds.length > 0 ? mergedFromIds : undefined,
      screenshotIds: combinedScreenshotIds,
      eventTime: existingNode.eventTime, // Keep existing event time
    };

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

    // Build screenshot ID mapping (screen_id -> database ID)
    const screenshotMapping = batch.screenshots.map((s, idx) => ({
      screen_id: idx + 1,
      database_id: s.id,
      ts: s.ts,
      source_key: s.sourceKey,
      app_hint: s.meta.appHint,
      window_title: s.meta.windowTitle,
    }));

    return `Expand the following VLM Index segments into storable context nodes.

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

## Instructions
1. For each segment, create an event node with the segment's event info
2. For each derived item (knowledge/state/procedure/plan), create a separate node
3. Use the screenshot_mapping to convert screen_ids to database_ids for screenshot_ids field
4. Enrich summaries with evidence from OCR text and UI snippets
5. Return ONLY valid JSON matching the output format

Return the expanded nodes JSON:`;
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
    segments: VLMSegment[]
  ): Promise<PendingNode[]> {
    const processedNodes = [...pendingNodes];
    let segmentIndex = 0;

    for (let i = 0; i < processedNodes.length; i++) {
      const node = processedNodes[i];

      // Only event nodes need thread assignment
      if (node.kind !== "event") {
        continue;
      }

      // Find corresponding segment
      const segment = segments[segmentIndex];
      segmentIndex++;

      if (!segment) {
        // No segment found, create new thread
        node.threadId = this.generateThreadId();
        continue;
      }

      const mergeHint = segment.merge_hint;

      if (mergeHint.decision === "MERGE" && mergeHint.thread_id) {
        // Use existing thread ID
        node.threadId = mergeHint.thread_id;
        logger.debug(
          { threadId: mergeHint.thread_id, nodeTitle: node.title },
          "Merging event into existing thread"
        );
      } else {
        // Create new thread
        node.threadId = this.generateThreadId();
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
  async callTextLLMForExpansion(
    vlmIndex: VLMIndexResult,
    batch: Batch,
    evidencePacks: EvidencePack[]
  ): Promise<unknown> {
    const aiService = AISDKService.getInstance();

    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    const prompt = this.buildExpandPrompt(vlmIndex, batch, evidencePacks);

    const { text: rawText } = await generateText({
      model: aiService.getTextClient(),
      system: TEXT_LLM_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
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
