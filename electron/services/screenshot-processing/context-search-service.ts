import { inArray, eq, and } from "drizzle-orm";
import { getDb } from "../../database";
import {
  vectorDocuments,
  contextNodes,
  screenshots,
  contextScreenshotLinks,
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
    const { query: queryText, filters, topK = 20, deepSearch = false } = query;

    try {
      let queryPlan: SearchQueryPlan | null = null;
      let embeddingText = queryText;
      let effectiveFilters = filters;

      // Deep Search: Query Understanding
      if (deepSearch) {
        logger.debug({ queryText }, "Deep Search enabled, understanding query");
        const nowTs = Date.now();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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

      // 1. Generate query embedding
      const queryEmbedding = await embeddingService.embed(embeddingText, abortSignal);

      // 2. Search vector index
      const matches = await vectorIndexService.search(queryEmbedding, topK);
      if (matches.length === 0) {
        return {
          nodes: [],
          relatedEvents: [],
          evidence: [],
          queryPlan: queryPlan ?? undefined,
        };
      }

      // Map docId to its match info (score)
      const matchMap = new Map(matches.map((m) => [m.docId, m]));
      const docIds = matches.map((m) => m.docId);

      // 3. Look up vector documents to get refIds (node IDs)
      const db = getDb();
      const docs = db
        .select({ id: vectorDocuments.id, refId: vectorDocuments.refId })
        .from(vectorDocuments)
        .where(inArray(vectorDocuments.id, docIds))
        .all();

      // Create a map of refId to its best index score
      const nodeScoreMap = new Map<number, number>();
      for (const doc of docs) {
        const match = matchMap.get(doc.id);
        if (match) {
          const currentScore = nodeScoreMap.get(doc.refId) ?? Infinity;
          // HNSW scores: lower is better (distance)
          nodeScoreMap.set(doc.refId, Math.min(currentScore, match.score));
        }
      }

      const nodeIds = Array.from(nodeScoreMap.keys());
      if (nodeIds.length === 0) {
        return {
          nodes: [],
          relatedEvents: [],
          evidence: [],
          queryPlan: queryPlan ?? undefined,
        };
      }

      // 4. Fetch context nodes
      const queryNodes = db.select().from(contextNodes).where(inArray(contextNodes.id, nodeIds));

      const nodeRecords = queryNodes.all();

      // Convert to expanded nodes
      let nodes = nodeRecords.map((record) => contextGraphService.recordToExpandedNode(record));

      // 5. Apply filters (MVP filtering at result level)
      nodes = this.applyFilters(nodes, effectiveFilters, db);

      // 6. Sort results by score (distance, ascending)
      nodes.sort((a, b) => {
        const scoreA = nodeScoreMap.get(a.id!) ?? Infinity;
        const scoreB = nodeScoreMap.get(b.id!) ?? Infinity;
        return scoreA - scoreB;
      });

      // 7. Backfill nodeId -> screenshotIds[] and fetch evidence (screenshots)
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

      // Deep Search: Answer Synthesis
      let answer = undefined;
      if (deepSearch && nodes.length > 0) {
        logger.debug({ nodeCount: nodes.length }, "Synthesizing answer");
        answer =
          (await deepSearchService.synthesizeAnswer(queryText, nodes, evidence, abortSignal)) ??
          undefined;
      }

      return {
        nodes,
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
        if (!node.eventTime) return false;
        if (node.eventTime < filters.timeRange.start || node.eventTime > filters.timeRange.end) {
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
        ts: s.ts,
        filePath: s.filePath ?? undefined,
        storageState: s.storageState,
        appHint: s.appHint ?? undefined,
        windowTitle: s.windowTitle ?? undefined,
      }))
      .sort((a, b) => b.ts - a.ts);
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
