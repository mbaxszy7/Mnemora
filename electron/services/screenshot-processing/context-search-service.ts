import { inArray, eq, and, gte, or, like, lte } from "drizzle-orm";
import { getDb } from "../../database";
import {
  vectorDocuments,
  contextNodes,
  screenshots,
  contextScreenshotLinks,
  activityEvents,
  activitySummaries,
  entityAliases,
} from "../../database/schema";
import { ErrorCode, ServiceError } from "@shared/errors";
import { getLogger } from "../logger";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";
import { contextGraphService } from "./context-graph-service";
import { deepSearchService } from "./deep-search-service";
import type {
  SearchQuery,
  SearchResult,
  ExpandedContextNode,
  ScreenshotEvidence,
  GraphTraversalResult,
  EdgeType,
  SearchFilters,
  SearchQueryPlan,
} from "./types";

const logger = getLogger("context-search-service");

export class ContextSearchService {
  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof Error && error.name === "AbortError") ||
      (error instanceof Error && error.message.toLowerCase().includes("abort"))
    );
  }

  /**
   * Perform semantic search across context nodes
   * With optional Deep Search: LLM query understanding + answer synthesis
   */
  async search(query: SearchQuery, abortSignal?: AbortSignal): Promise<SearchResult> {
    const { query: queryText, filters, topK = 20, deepSearch = true } = query;

    try {
      let queryPlan: SearchQueryPlan | null = null;
      let embeddingText = queryText;
      let effectiveFilters = filters;

      const nowTs = Date.now();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Deep Search: Query Understanding
      if (deepSearch) {
        logger.debug({ queryText }, "Deep Search enabled, understanding query");

        queryPlan = await deepSearchService.understandQuery(
          queryText,
          nowTs,
          timezone,
          abortSignal
        );

        if (queryPlan) {
          // Use optimized embedding text
          embeddingText = queryPlan.embeddingText;
          // Merge filters (respects user's threadId)
          effectiveFilters = deepSearchService.mergeFilters(filters, queryPlan);

          logger.debug(
            {
              originalQuery: queryText,
              embeddingText,
              confidence: queryPlan.confidence,
            },
            "Query understanding completed"
          );
        }
      }

      // 1. Direct Retrieval: SQL Fallback for Keywords & Entities
      const db = getDb();
      let keywordNodes: ExpandedContextNode[] = [];

      // Expand search terms with entities/keywords from query plan
      const searchTerms = new Set<string>();
      if (queryPlan) {
        queryPlan.extractedEntities?.forEach((e) => searchTerms.add(e.name));
        queryPlan.keywords?.forEach((k) => searchTerms.add(k));
      }

      if (searchTerms.size > 0) {
        logger.debug({ terms: Array.from(searchTerms) }, "Performing keyword SQL search");

        // Resolve aliases for found entities to catch more nodes
        const aliasRecords = db
          .select()
          .from(entityAliases)
          .where(
            or(...Array.from(searchTerms).map((term) => like(entityAliases.alias, `%${term}%`)))
          )
          .all();

        const resolvedEntityIds = Array.from(new Set(aliasRecords.map((a) => a.entityId)));

        // Search nodes by title, summary, or resolved entity IDs
        const conditions = [
          or(
            ...Array.from(searchTerms).map((term) => like(contextNodes.title, `%${term}%`)),
            ...Array.from(searchTerms).map((term) => like(contextNodes.summary, `%${term}%`)),
            resolvedEntityIds.length > 0 ? inArray(contextNodes.id, resolvedEntityIds) : undefined
          ),
        ];

        if (effectiveFilters?.timeRange) {
          conditions.push(gte(contextNodes.eventTime, effectiveFilters.timeRange.start));
          conditions.push(lte(contextNodes.eventTime, effectiveFilters.timeRange.end));
        }

        const sqlMatches = db
          .select()
          .from(contextNodes)
          .where(and(...conditions))
          .all();

        keywordNodes = sqlMatches.map((record) => contextGraphService.recordToExpandedNode(record));
        // Apply filters to keyword results
        keywordNodes = this.applyFilters(keywordNodes, effectiveFilters, db);
      }

      // 1b. Direct Retrieval: High Importance/Confidence nodes via Filters
      let filteredNodes: ExpandedContextNode[] = [];
      if (effectiveFilters) {
        logger.debug("Performing direct filtered search for high-importance nodes");
        const filteredNodeConditions = [
          gte(contextNodes.importance, 7),
          gte(contextNodes.confidence, 9),
        ];

        if (effectiveFilters.timeRange) {
          filteredNodeConditions.push(
            gte(contextNodes.eventTime, effectiveFilters.timeRange.start)
          );
          filteredNodeConditions.push(lte(contextNodes.eventTime, effectiveFilters.timeRange.end));
        }

        const filteredNodeRecords = db
          .select()
          .from(contextNodes)
          .where(and(...filteredNodeConditions))
          .all();

        filteredNodes = filteredNodeRecords.map((record) =>
          contextGraphService.recordToExpandedNode(record)
        );
        // Apply more specific filters (timeRange, entities, appHint)
        filteredNodes = this.applyFilters(filteredNodes, effectiveFilters, db);
        logger.debug({ count: filteredNodes.length }, "Direct filtered search completed");
      }

      // 2. Semantic Search (Vector Index)
      let semanticNodes: ExpandedContextNode[] = [];
      const nodeScoreMap = new Map<number, number>();

      // Generate query embedding
      const queryEmbedding = await embeddingService.embed(embeddingText, abortSignal);

      // Search vector index
      const matches = await vectorIndexService.search(queryEmbedding, topK);
      if (matches.length > 0) {
        // Map docId to its match info (score)
        const matchMap = new Map(matches.map((m) => [m.docId, m]));
        const docIds = matches.map((m) => m.docId);

        // Look up vector documents to get refIds (node IDs)
        const docs = db
          .select({ id: vectorDocuments.id, refId: vectorDocuments.refId })
          .from(vectorDocuments)
          .where(inArray(vectorDocuments.id, docIds))
          .all();

        // Create a map of refId to its best index score
        for (const doc of docs) {
          const match = matchMap.get(doc.id);
          if (match) {
            const currentScore = nodeScoreMap.get(doc.refId) ?? Infinity;
            // HNSW scores: lower is better (distance)
            nodeScoreMap.set(doc.refId, Math.min(currentScore, match.score));
          }
        }

        const semanticNodeIds = Array.from(nodeScoreMap.keys());
        if (semanticNodeIds.length > 0) {
          const semanticNodeRecords = db
            .select()
            .from(contextNodes)
            .where(inArray(contextNodes.id, semanticNodeIds))
            .all();

          semanticNodes = semanticNodeRecords.map((record) =>
            contextGraphService.recordToExpandedNode(record)
          );
          // Apply filters to semantic results too
          semanticNodes = this.applyFilters(semanticNodes, effectiveFilters, db);
        }
      }

      // 3. Combine and Merge Results
      const combinedNodeMap = new Map<number, ExpandedContextNode>();

      // Add direct filtered nodes first
      for (const node of filteredNodes) {
        if (node.id !== undefined) combinedNodeMap.set(node.id, node);
      }

      // Add keyword fallback nodes
      for (const node of keywordNodes) {
        if (node.id !== undefined && !combinedNodeMap.has(node.id)) {
          combinedNodeMap.set(node.id, node);
        }
      }

      // Add semantic nodes
      for (const node of semanticNodes) {
        if (node.id !== undefined && !combinedNodeMap.has(node.id)) {
          combinedNodeMap.set(node.id, node);
        }
      }

      // 3b. Temporal Expansion: Fetch neighbors for top results
      const pivotNodes = Array.from(combinedNodeMap.values()).slice(0, 5);
      const ranges = pivotNodes
        .filter((n) => n.eventTime)
        .map((n) => ({
          start: n.eventTime! - 120000,
          end: n.eventTime! + 120000,
        }));

      if (ranges.length > 0) {
        const neighborRecords = db
          .select()
          .from(contextNodes)
          .where(
            or(
              ...ranges.map((r) =>
                and(gte(contextNodes.eventTime, r.start), lte(contextNodes.eventTime, r.end))
              )
            )
          )
          .limit(10)
          .all();

        for (const record of neighborRecords) {
          if (!combinedNodeMap.has(record.id)) {
            const node = contextGraphService.recordToExpandedNode(record);
            // Neighbor expansion should generally stay within the requested filters if present
            const filtered = this.applyFilters([node], effectiveFilters, db);
            if (filtered.length > 0) {
              combinedNodeMap.set(record.id, node);
            }
          }
        }
      }

      // 3c. Cross-Table Retrieval: Activity Events & Summaries
      const eventConditions = [
        or(
          ...Array.from(searchTerms).map((term) => like(activityEvents.title, `%${term}%`)),
          ...Array.from(searchTerms).map((term) => like(activityEvents.details, `%${term}%`))
        ),
      ];

      if (effectiveFilters?.timeRange) {
        eventConditions.push(gte(activityEvents.startTs, effectiveFilters.timeRange.start));
        eventConditions.push(lte(activityEvents.startTs, effectiveFilters.timeRange.end));
      }

      const matchedEvents = db
        .select()
        .from(activityEvents)
        .where(and(...eventConditions))
        .limit(5)
        .all();

      const summaryConditions = [
        or(
          ...Array.from(searchTerms).map((term) => like(activitySummaries.title, `%${term}%`)),
          ...Array.from(searchTerms).map((term) => like(activitySummaries.summary, `%${term}%`))
        ),
      ];

      if (effectiveFilters?.timeRange) {
        summaryConditions.push(
          gte(activitySummaries.windowStart, effectiveFilters.timeRange.start)
        );
        summaryConditions.push(lte(activitySummaries.windowStart, effectiveFilters.timeRange.end));
      }

      const matchedSummaries = db
        .select()
        .from(activitySummaries)
        .where(and(...summaryConditions))
        .limit(3)
        .all();

      // Map and add to combined results
      const tempCrossNodes: ExpandedContextNode[] = [];
      matchedEvents.forEach((e) => {
        tempCrossNodes.push({
          id: -e.id,
          kind: "event",
          title: `Summary: ${e.title}`,
          summary: e.details ?? "",
          eventTime: e.startTs,
          keywords: [],
          entities: [],
          importance: e.importance,
          confidence: e.confidence / 10,
          screenshotIds: JSON.parse(e.nodeIds ?? "[]"),
        });
      });

      matchedSummaries.forEach((s) => {
        tempCrossNodes.push({
          id: -10000 - s.id,
          kind: "knowledge",
          title: s.title ?? "Period Summary",
          summary: s.summary,
          eventTime: s.windowStart,
          keywords: JSON.parse(s.highlights ?? "[]"),
          entities: [],
          importance: 7,
          confidence: 9,
          screenshotIds: [],
        });
      });

      // Apply filters to cross-table results
      const filteredCrossNodes = this.applyFilters(tempCrossNodes, effectiveFilters, db);
      for (const node of filteredCrossNodes) {
        if (!combinedNodeMap.has(node.id!)) {
          combinedNodeMap.set(node.id!, node);
        }
      }

      const nodes = Array.from(combinedNodeMap.values());

      if (nodes.length === 0) {
        logger.info({ searchQuery: embeddingText }, "No nodes matched filters or semantic search");
        return {
          nodes: [],
          relatedEvents: [],
          evidence: [],
          queryPlan: queryPlan ?? undefined,
        };
      }

      // 4. Sort results with Importance-Weighted Ranking
      // FinalScore = SemanticDistance * (1.2 - (importance / 10))
      // Lower score is better (HNSW distance)
      nodes.sort((a, b) => {
        // Direct matches or keyword matches have score 0 (best)
        const scoreA = nodeScoreMap.get(a.id!) ?? 0;
        const scoreB = nodeScoreMap.get(b.id!) ?? 0;

        const weightA = 1.2 - (a.importance ?? 5) / 10;
        const weightB = 1.2 - (b.importance ?? 5) / 10;

        const finalA = scoreA * weightA;
        const finalB = scoreB * weightB;

        // Prioritize direct matches (score 0)
        if (scoreA === 0 && scoreB !== 0) return -1;
        if (scoreA !== 0 && scoreB === 0) return 1;

        return finalA - finalB;
      });

      // 5. Backfill nodeId -> screenshotIds[] and fetch evidence (screenshots)
      const finalNodeIds = nodes.map((n) => n.id!).filter(Boolean);
      const screenshotIdsByNodeId = this.getScreenshotIdsByNodeIds(finalNodeIds);

      for (const node of nodes) {
        if (node.id !== undefined) {
          node.screenshotIds = screenshotIdsByNodeId.get(node.id) ?? [];
        }
      }

      const allScreenshotIds: number[] = [];
      for (const ids of screenshotIdsByNodeId.values()) {
        allScreenshotIds.push(...ids);
      }
      const evidence = await this.getEvidenceForScreenshotIds(
        Array.from(new Set(allScreenshotIds))
      );

      // 8. Fetch related events
      const relatedEvents = nodes.filter((n) => n.kind === "event");
      let otherNodes = nodes.filter((n) => n.kind !== "event");

      // Sort otherNodes by kindHint if present (prioritize requested kind)
      if (queryPlan?.kindHint) {
        otherNodes = [...otherNodes].sort((a, b) => {
          const aMatches = a.kind === queryPlan!.kindHint;
          const bMatches = b.kind === queryPlan!.kindHint;
          if (aMatches && !bMatches) return -1;
          if (!aMatches && bMatches) return 1;
          return 0; // Maintain relative semantic score order
        });
      }

      // Deep Search: Answer Synthesis
      let answer = undefined;
      if (deepSearch && nodes.length > 0) {
        logger.debug({ nodeCount: nodes.length }, "Synthesizing answer");
        answer =
          (await deepSearchService.synthesizeAnswer(
            queryText,
            nodes,
            evidence,
            nowTs,
            timezone,
            abortSignal
          )) ?? undefined;
      }

      return {
        nodes: queryPlan?.kindHint
          ? otherNodes.filter((n) => n.kind === queryPlan.kindHint)
          : otherNodes,
        relatedEvents,
        evidence,
        queryPlan: queryPlan ?? undefined,
        answer,
      };
    } catch (error) {
      if (abortSignal?.aborted || this.isAbortError(error)) {
        logger.debug({ query: queryText }, "Semantic search cancelled");
        throw new ServiceError(ErrorCode.CANCELLED, "Cancelled");
      }

      logger.error({ error, query: queryText }, "Semantic search failed");
      throw error;
    }
  }

  /**
   * Apply filters to nodes
   */
  private applyFilters(
    nodes: ExpandedContextNode[],
    filters: SearchFilters | undefined,
    db: ReturnType<typeof getDb>
  ): ExpandedContextNode[] {
    if (!filters) return nodes;

    let result = nodes.filter((node) => {
      // Time range filter
      if (filters.timeRange) {
        const nodeTime = node.eventTime || node.createdAt;
        if (!nodeTime) return false;
        if (nodeTime < filters.timeRange.start || nodeTime > filters.timeRange.end) {
          return false;
        }
      }

      // Thread ID filter
      if (filters.threadId && node.threadId !== filters.threadId) {
        return false;
      }

      // Entities filter (match if node mentions at least one entity)
      if (filters.entities && filters.entities.length > 0) {
        const wanted = filters.entities
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.length > 0);
        if (wanted.length > 0) {
          const nodeEntities = node.entities.map((e) => e.name.trim().toLowerCase());
          const matched = wanted.some((w) => nodeEntities.includes(w));
          if (!matched) return false;
        }
      }

      return true;
    });

    // App Hint filter (requires checking linked screenshots)
    if (filters.appHint && result.length > 0) {
      const filteredNodeIds = result
        .map((n) => n.id)
        .filter((id): id is number => id !== undefined);

      // JOIN query to find nodes that have at least one linked screenshot with the matching appHint
      const nodeIdsWithAppHint = db
        .select({ nodeId: contextScreenshotLinks.nodeId })
        .from(contextScreenshotLinks)
        .innerJoin(screenshots, eq(contextScreenshotLinks.screenshotId, screenshots.id))
        .where(
          and(
            inArray(contextScreenshotLinks.nodeId, filteredNodeIds),
            eq(screenshots.appHint, filters.appHint)
          )
        )
        .all()
        .map((r) => r.nodeId);

      const nodeIdSet = new Set(nodeIdsWithAppHint);
      result = result.filter((n) => n.id && nodeIdSet.has(n.id));
    }

    return result;
  }

  private getScreenshotIdsByNodeIds(nodeIds: number[]): Map<number, number[]> {
    const screenshotIdsByNodeId = new Map<number, Set<number>>();

    if (nodeIds.length === 0) {
      return new Map();
    }

    const db = getDb();
    const links = db
      .select({
        nodeId: contextScreenshotLinks.nodeId,
        screenshotId: contextScreenshotLinks.screenshotId,
      })
      .from(contextScreenshotLinks)
      .where(inArray(contextScreenshotLinks.nodeId, nodeIds))
      .all();

    for (const link of links) {
      let set = screenshotIdsByNodeId.get(link.nodeId);
      if (!set) {
        set = new Set<number>();
        screenshotIdsByNodeId.set(link.nodeId, set);
      }
      set.add(link.screenshotId);
    }

    const result = new Map<number, number[]>();
    for (const [nodeId, set] of screenshotIdsByNodeId) {
      result.set(nodeId, Array.from(set));
    }
    return result;
  }

  private async getEvidenceForScreenshotIds(
    screenshotIds: number[]
  ): Promise<ScreenshotEvidence[]> {
    if (screenshotIds.length === 0) return [];

    const db = getDb();

    // Fetch screenshot records
    const screenshotRecords = db
      .select()
      .from(screenshots)
      .where(inArray(screenshots.id, screenshotIds))
      .all();

    // Map and sort by timestamp (newest first)
    return screenshotRecords
      .map((s) => ({
        screenshotId: s.id,
        timestamp: s.ts,
        appHint: s.appHint ?? undefined,
        windowTitle: s.windowTitle ?? undefined,
        uiTextSnippets: s.uiTextSnippets ? JSON.parse(s.uiTextSnippets) : undefined,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get evidence (screenshots) for a set of nodes
   */
  async getEvidence(nodeIds: number[]): Promise<ScreenshotEvidence[]> {
    const screenshotIdsByNodeId = this.getScreenshotIdsByNodeIds(nodeIds);

    const allScreenshotIds: number[] = [];
    for (const ids of screenshotIdsByNodeId.values()) {
      allScreenshotIds.push(...ids);
    }

    return this.getEvidenceForScreenshotIds(Array.from(new Set(allScreenshotIds)));
  }

  /**
   * Get all events in a thread
   */
  async getThread(threadId: string): Promise<ExpandedContextNode[]> {
    const records = await contextGraphService.getThread(threadId);
    const nodes = records.map((r) => contextGraphService.recordToExpandedNode(r));

    const nodeIds = nodes.map((n) => n.id).filter((id): id is number => id !== undefined);
    const screenshotIdsByNodeId = this.getScreenshotIdsByNodeIds(nodeIds);

    for (const node of nodes) {
      if (node.id !== undefined) {
        node.screenshotIds = screenshotIdsByNodeId.get(node.id) ?? [];
      }
    }

    return nodes;
  }

  /**
   * Traverse the graph from a starting node
   */
  async traverse(
    nodeId: string,
    depth: number,
    edgeTypes?: EdgeType[]
  ): Promise<GraphTraversalResult> {
    const result = await contextGraphService.traverse(nodeId, edgeTypes ?? ["event_next"], depth);

    const nodeIds = result.nodes.map((n) => n.id).filter((id): id is number => id !== undefined);
    const screenshotIdsByNodeId = this.getScreenshotIdsByNodeIds(nodeIds);

    for (const node of result.nodes) {
      if (node.id !== undefined) {
        node.screenshotIds = screenshotIdsByNodeId.get(node.id) ?? [];
      }
    }

    return result;
  }
}

export const contextSearchService = new ContextSearchService();
