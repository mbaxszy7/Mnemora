/**
 * Context Graph Service
 *
 * Manages the context graph for storing and querying context nodes and their relationships.
 * Provides methods for creating nodes, edges, and traversing the graph.
 *
 * Public API (orchestration layer):
 * - createNode, updateNode, createEdge, linkScreenshot
 * - getThread, traverse, getPendingEmbeddingNodes
 *
 * Internal helpers (not exported from index.ts):
 * - getNode, getNodesByIds, getLinkedScreenshots, getEdgesFrom, getEdgesTo
 * - recordToExpandedNode
 */

import { eq, and, inArray } from "drizzle-orm";

import { getDb } from "../../database";
import {
  contextNodes,
  contextEdges,
  contextScreenshotLinks,
  type ContextNodeRecord,
  type NewContextNodeRecord,
  type NewContextEdgeRecord,
  type NewContextScreenshotLinkRecord,
  type ContextKind,
  type EdgeType,
} from "../../database/schema";
import { getLogger } from "../logger";
import type { ExpandedContextNode, EntityRef, GraphTraversalResult } from "./types";

const logger = getLogger("context-graph-service");

// ============================================================================
// Types
// ============================================================================

/**
 * Input for creating a context node
 */
export interface CreateNodeInput {
  kind: ContextKind;
  threadId?: string;
  title: string;
  summary: string;
  keywords?: string[];
  entities?: EntityRef[];
  importance?: number;
  confidence?: number;
  eventTime?: number;
  mergedFromIds?: number[];
  screenshotIds?: number[];
  payloadJson?: string;
  /** Source event ID for derived nodes (knowledge/state/procedure/plan) - REQUIRED for derived nodes */
  sourceEventId?: number;
}

/**
 * Input for updating a context node
 */
export interface UpdateNodeInput {
  title?: string;
  summary?: string;
  keywords?: string[];
  entities?: EntityRef[];
  importance?: number;
  confidence?: number;
  eventTime?: number;
  mergedFromIds?: number[];
  payloadJson?: string;
  mergeStatus?: "pending" | "succeeded" | "failed";
  embeddingStatus?: "pending" | "succeeded" | "failed";
}

// ============================================================================
// Derived Node Edge Type Mapping
// ============================================================================

/**
 * Maps derived node kinds to their corresponding edge types
 */
const DERIVED_KIND_TO_EDGE_TYPE: Partial<Record<ContextKind, EdgeType>> = {
  knowledge: "event_produces_knowledge",
  state_snapshot: "event_updates_state",
  procedure: "event_uses_procedure",
  plan: "event_suggests_plan",
};

/**
 * Kinds that are considered derived nodes (require source event edge)
 */
const DERIVED_KINDS: ContextKind[] = ["knowledge", "state_snapshot", "procedure", "plan"];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safe JSON parse with fallback
 */
function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// ============================================================================
// Context Graph Service Class
// ============================================================================

/**
 * Service for managing the context graph
 */
export class ContextGraphService {
  /**
   * Create a new context node
   *
   * - Automatically sets embedding_status to 'pending'
   * - For derived nodes (knowledge/state/procedure/plan), sourceEventId is REQUIRED
   *   and an edge is automatically created from the source event
   * - For event nodes with threadId, automatically creates event_next edge to previous event
   *
   * @param input - Node creation input
   * @returns The created node's ID as a string
   */
  async createNode(input: CreateNodeInput): Promise<string> {
    const db = getDb();
    const now = Date.now();

    // Enforce: derived nodes must have sourceEventId
    if (DERIVED_KINDS.includes(input.kind)) {
      if (!input.sourceEventId) {
        throw new Error(`Derived node of kind '${input.kind}' requires sourceEventId`);
      }
    }

    // Prepare the node record
    const nodeRecord: NewContextNodeRecord = {
      kind: input.kind,
      threadId: input.threadId,
      title: input.title,
      summary: input.summary,
      keywords: input.keywords ? JSON.stringify(input.keywords) : null,
      entities: input.entities ? JSON.stringify(input.entities) : null,
      importance: input.importance ?? 5,
      confidence: input.confidence ?? 5,
      eventTime: input.eventTime,
      mergedFromIds: input.mergedFromIds ? JSON.stringify(input.mergedFromIds) : null,
      payloadJson: input.payloadJson,
      mergeStatus: "pending",
      embeddingStatus: "pending", // Always set to pending on creation
      createdAt: now,
      updatedAt: now,
    };

    // Insert the node
    const result = db.insert(contextNodes).values(nodeRecord).returning({ id: contextNodes.id });
    const [inserted] = result.all();

    if (!inserted) {
      throw new Error("Failed to create context node");
    }

    const nodeId = inserted.id;
    logger.debug({ nodeId, kind: input.kind, title: input.title }, "Created context node");

    // For derived nodes, automatically create edge to source event
    if (DERIVED_KINDS.includes(input.kind) && input.sourceEventId) {
      const edgeType = DERIVED_KIND_TO_EDGE_TYPE[input.kind];
      if (edgeType) {
        this.createEdgeInternal(input.sourceEventId, nodeId, edgeType);
        logger.debug(
          { fromId: input.sourceEventId, toId: nodeId, edgeType },
          "Created derived node edge"
        );
      }
    }

    // If this is an event node with a threadId, create event_next edge to previous event
    if (input.kind === "event" && input.threadId && input.eventTime) {
      const previousEvent = this.getPreviousEventInThread(input.threadId, input.eventTime);
      if (previousEvent) {
        this.createEdgeInternal(previousEvent.id, nodeId, "event_next");
        logger.debug(
          { fromId: previousEvent.id, toId: nodeId, threadId: input.threadId },
          "Created event_next edge for thread continuity"
        );
      }
    }

    // Batch link screenshots if provided
    if (input.screenshotIds && input.screenshotIds.length > 0) {
      this.batchLinkScreenshots(nodeId, input.screenshotIds);
    }

    return nodeId.toString();
  }

  /**
   * Update an existing context node
   *
   * @param nodeId - The node ID to update (as string)
   * @param updates - The fields to update
   */
  async updateNode(nodeId: string, updates: UpdateNodeInput): Promise<void> {
    const db = getDb();
    const id = parseInt(nodeId, 10);

    if (isNaN(id)) {
      throw new Error(`Invalid node ID: ${nodeId}`);
    }

    const updateData: Partial<ContextNodeRecord> = {
      updatedAt: Date.now(),
    };

    if (updates.title !== undefined) {
      updateData.title = updates.title;
    }
    if (updates.summary !== undefined) {
      updateData.summary = updates.summary;
    }
    if (updates.keywords !== undefined) {
      updateData.keywords = JSON.stringify(updates.keywords);
    }
    if (updates.entities !== undefined) {
      updateData.entities = JSON.stringify(updates.entities);
    }
    if (updates.importance !== undefined) {
      updateData.importance = updates.importance;
    }
    if (updates.confidence !== undefined) {
      updateData.confidence = updates.confidence;
    }
    if (updates.eventTime !== undefined) {
      updateData.eventTime = updates.eventTime;
    }
    if (updates.mergedFromIds !== undefined) {
      updateData.mergedFromIds = JSON.stringify(updates.mergedFromIds);
    }
    if (updates.payloadJson !== undefined) {
      updateData.payloadJson = updates.payloadJson;
    }
    if (updates.mergeStatus !== undefined) {
      updateData.mergeStatus = updates.mergeStatus;
    }
    if (updates.embeddingStatus !== undefined) {
      updateData.embeddingStatus = updates.embeddingStatus;
    }

    db.update(contextNodes).set(updateData).where(eq(contextNodes.id, id)).run();

    logger.debug({ nodeId, updates: Object.keys(updates) }, "Updated context node");
  }

  /**
   * Create an edge between two nodes (public API - accepts string IDs)
   *
   * Uses UNIQUE constraint to avoid duplicate edges (upsert behavior via INSERT OR IGNORE)
   *
   * @param fromId - Source node ID (as string)
   * @param toId - Target node ID (as string)
   * @param edgeType - Type of the edge
   */
  async createEdge(fromId: string, toId: string, edgeType: EdgeType): Promise<void> {
    const fromNodeId = parseInt(fromId, 10);
    const toNodeId = parseInt(toId, 10);

    if (isNaN(fromNodeId) || isNaN(toNodeId)) {
      throw new Error(`Invalid node IDs: fromId=${fromId}, toId=${toId}`);
    }

    this.createEdgeInternal(fromNodeId, toNodeId, edgeType);
  }

  /**
   * Internal edge creation (accepts number IDs directly)
   * No redundant try/catch - onConflictDoNothing handles duplicates
   */
  private createEdgeInternal(fromNodeId: number, toNodeId: number, edgeType: EdgeType): void {
    const db = getDb();

    const edgeRecord: NewContextEdgeRecord = {
      fromNodeId,
      toNodeId,
      edgeType,
      createdAt: Date.now(),
    };

    db.insert(contextEdges)
      .values(edgeRecord)
      .onConflictDoNothing({
        target: [contextEdges.fromNodeId, contextEdges.toNodeId, contextEdges.edgeType],
      })
      .run();

    logger.debug({ fromNodeId, toNodeId, edgeType }, "Created context edge");
  }

  /**
   * Link a screenshot to a context node (public API - accepts string IDs)
   *
   * @param nodeId - The node ID (as string)
   * @param screenshotId - The screenshot ID (as string)
   */
  async linkScreenshot(nodeId: string, screenshotId: string): Promise<void> {
    const nId = parseInt(nodeId, 10);
    const sId = parseInt(screenshotId, 10);

    if (isNaN(nId) || isNaN(sId)) {
      throw new Error(`Invalid IDs: nodeId=${nodeId}, screenshotId=${screenshotId}`);
    }

    this.linkScreenshotInternal(nId, sId);
  }

  /**
   * Internal screenshot linking (accepts number IDs directly)
   * No redundant try/catch - onConflictDoNothing handles duplicates
   */
  private linkScreenshotInternal(nodeId: number, screenshotId: number): void {
    const db = getDb();

    const linkRecord: NewContextScreenshotLinkRecord = {
      nodeId,
      screenshotId,
      createdAt: Date.now(),
    };

    db.insert(contextScreenshotLinks)
      .values(linkRecord)
      .onConflictDoNothing({
        target: [contextScreenshotLinks.nodeId, contextScreenshotLinks.screenshotId],
      })
      .run();

    logger.debug({ nodeId, screenshotId }, "Linked screenshot to node");
  }

  /**
   * Batch link multiple screenshots to a node (optimized)
   */
  private batchLinkScreenshots(nodeId: number, screenshotIds: number[]): void {
    const db = getDb();
    const now = Date.now();

    const linkRecords: NewContextScreenshotLinkRecord[] = screenshotIds.map((screenshotId) => ({
      nodeId,
      screenshotId,
      createdAt: now,
    }));

    db.insert(contextScreenshotLinks)
      .values(linkRecords)
      .onConflictDoNothing({
        target: [contextScreenshotLinks.nodeId, contextScreenshotLinks.screenshotId],
      })
      .run();

    logger.debug({ nodeId, count: screenshotIds.length }, "Batch linked screenshots to node");
  }

  /**
   * Get all event nodes in a thread
   *
   * @param threadId - The thread identifier
   * @returns Array of context nodes in the thread, ordered by event time
   */
  async getThread(threadId: string): Promise<ContextNodeRecord[]> {
    const db = getDb();

    const nodes = db
      .select()
      .from(contextNodes)
      .where(and(eq(contextNodes.threadId, threadId), eq(contextNodes.kind, "event")))
      .orderBy(contextNodes.eventTime)
      .all();

    logger.debug({ threadId, nodeCount: nodes.length }, "Retrieved thread nodes");
    return nodes;
  }

  /**
   * Traverse the graph from a starting node
   *
   * Performs breadth-first traversal following specified edge types up to a maximum depth.
   * Returns GraphTraversalResult with ExpandedContextNode[] for consistency with types.ts
   *
   * @param nodeId - Starting node ID (as string)
   * @param edgeTypes - Edge types to follow
   * @param depth - Maximum traversal depth
   * @returns Traversal result with nodes, edges, and screenshot IDs
   */
  async traverse(
    nodeId: string,
    edgeTypes: EdgeType[],
    depth: number
  ): Promise<GraphTraversalResult> {
    const db = getDb();
    const startId = parseInt(nodeId, 10);

    if (isNaN(startId)) {
      throw new Error(`Invalid node ID: ${nodeId}`);
    }

    const visitedNodeIds = new Set<number>();
    const edgeSet = new Set<string>(); // For deduplication: "fromId-toId-edgeType"
    const collectedEdges: Array<{ fromId: number; toId: number; edgeType: EdgeType }> = [];
    const screenshotIds = new Set<number>();

    // BFS traversal - optimized with batch queries per level
    let currentLevel = [startId];
    let currentDepth = 0;

    while (currentLevel.length > 0 && currentDepth <= depth) {
      // Filter out already visited nodes
      const unvisitedInLevel = currentLevel.filter((id) => !visitedNodeIds.has(id));
      if (unvisitedInLevel.length === 0) {
        break;
      }

      // Mark as visited
      for (const id of unvisitedInLevel) {
        visitedNodeIds.add(id);
      }

      // Batch query screenshot links for current level
      const links = db
        .select()
        .from(contextScreenshotLinks)
        .where(inArray(contextScreenshotLinks.nodeId, unvisitedInLevel))
        .all();

      for (const link of links) {
        screenshotIds.add(link.screenshotId);
      }

      // Get edges for next level (only if not at max depth)
      const nextLevel: number[] = [];
      if (currentDepth < depth) {
        // Batch query outgoing edges
        const outgoingEdges = db
          .select()
          .from(contextEdges)
          .where(
            and(
              inArray(contextEdges.fromNodeId, unvisitedInLevel),
              inArray(contextEdges.edgeType, edgeTypes)
            )
          )
          .all();

        for (const edge of outgoingEdges) {
          const edgeKey = `${edge.fromNodeId}-${edge.toNodeId}-${edge.edgeType}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            collectedEdges.push({
              fromId: edge.fromNodeId,
              toId: edge.toNodeId,
              edgeType: edge.edgeType as EdgeType,
            });
          }
          if (!visitedNodeIds.has(edge.toNodeId)) {
            nextLevel.push(edge.toNodeId);
          }
        }

        // Batch query incoming edges (for bidirectional traversal)
        const incomingEdges = db
          .select()
          .from(contextEdges)
          .where(
            and(
              inArray(contextEdges.toNodeId, unvisitedInLevel),
              inArray(contextEdges.edgeType, edgeTypes)
            )
          )
          .all();

        for (const edge of incomingEdges) {
          const edgeKey = `${edge.fromNodeId}-${edge.toNodeId}-${edge.edgeType}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            collectedEdges.push({
              fromId: edge.fromNodeId,
              toId: edge.toNodeId,
              edgeType: edge.edgeType as EdgeType,
            });
          }
          if (!visitedNodeIds.has(edge.fromNodeId)) {
            nextLevel.push(edge.fromNodeId);
          }
        }
      }

      currentLevel = nextLevel;
      currentDepth++;
    }

    // Fetch all visited nodes and convert to ExpandedContextNode
    const nodeIds = Array.from(visitedNodeIds);
    const nodeRecords =
      nodeIds.length > 0
        ? db.select().from(contextNodes).where(inArray(contextNodes.id, nodeIds)).all()
        : [];

    const expandedNodes = nodeRecords.map((record) => this.recordToExpandedNode(record));

    logger.debug(
      {
        startNodeId: nodeId,
        depth,
        edgeTypes,
        nodesFound: expandedNodes.length,
        edgesFound: collectedEdges.length,
        screenshotsFound: screenshotIds.size,
      },
      "Graph traversal completed"
    );

    return {
      nodes: expandedNodes,
      edges: collectedEdges,
      screenshotIds: Array.from(screenshotIds),
    };
  }

  /**
   * Get nodes with pending embedding status
   *
   * @param limit - Maximum number of nodes to return
   * @returns Array of nodes with pending embedding status
   */
  async getPendingEmbeddingNodes(limit: number = 100): Promise<ContextNodeRecord[]> {
    const db = getDb();

    return db
      .select()
      .from(contextNodes)
      .where(eq(contextNodes.embeddingStatus, "pending"))
      .limit(limit)
      .all();
  }

  // ============================================================================
  // Internal Helper Methods (not exported from index.ts)
  // ============================================================================

  /**
   * Get a single node by ID
   * @internal
   */
  getNode(nodeId: string): ContextNodeRecord | null {
    const db = getDb();
    const id = parseInt(nodeId, 10);

    if (isNaN(id)) {
      return null;
    }

    const [node] = db.select().from(contextNodes).where(eq(contextNodes.id, id)).all();

    return node || null;
  }

  /**
   * Get nodes by their IDs
   * @internal
   */
  getNodesByIds(nodeIds: string[]): ContextNodeRecord[] {
    const db = getDb();
    const ids = nodeIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));

    if (ids.length === 0) {
      return [];
    }

    return db.select().from(contextNodes).where(inArray(contextNodes.id, ids)).all();
  }

  /**
   * Get screenshot IDs linked to a node
   * @internal
   */
  getLinkedScreenshots(nodeId: string): number[] {
    const db = getDb();
    const id = parseInt(nodeId, 10);

    if (isNaN(id)) {
      return [];
    }

    const links = db
      .select()
      .from(contextScreenshotLinks)
      .where(eq(contextScreenshotLinks.nodeId, id))
      .all();

    return links.map((link) => link.screenshotId);
  }

  /**
   * Get the previous event in a thread (for event_next edge creation)
   * @internal
   */
  private getPreviousEventInThread(
    threadId: string,
    currentEventTime: number
  ): ContextNodeRecord | null {
    const db = getDb();

    const events = db
      .select()
      .from(contextNodes)
      .where(and(eq(contextNodes.threadId, threadId), eq(contextNodes.kind, "event")))
      .orderBy(contextNodes.eventTime)
      .all();

    // Find the most recent event before the current one
    const previousEvents = events
      .filter((event) => event.eventTime && event.eventTime < currentEventTime)
      .reverse();

    return previousEvents[0] || null;
  }

  /**
   * Convert a ContextNodeRecord to ExpandedContextNode
   * Uses safe JSON parsing with fallbacks
   * @internal
   */
  recordToExpandedNode(record: ContextNodeRecord): ExpandedContextNode {
    return {
      id: record.id,
      kind: record.kind,
      threadId: record.threadId ?? undefined,
      title: record.title,
      summary: record.summary,
      keywords: safeJsonParse<string[]>(record.keywords, []),
      entities: safeJsonParse<EntityRef[]>(record.entities, []),
      importance: record.importance,
      confidence: record.confidence,
      mergedFromIds: safeJsonParse<number[] | undefined>(record.mergedFromIds, undefined),
      screenshotIds: [], // Will be populated separately if needed
      eventTime: record.eventTime ?? undefined,
    };
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Singleton instance of ContextGraphService
 */
export const contextGraphService = new ContextGraphService();
