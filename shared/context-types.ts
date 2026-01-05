/**
 * Shared Context Graph Types
 *
 * This file contains type definitions shared between the Electron main process
 * and the Renderer process for context graph operations.
 */

export type ContextKind =
  | "event"
  | "knowledge"
  | "state_snapshot"
  | "procedure"
  | "plan"
  | "entity_profile";

export type EdgeType =
  | "event_next"
  | "event_mentions_entity"
  | "event_produces_knowledge"
  | "event_updates_state"
  | "event_suggests_plan"
  | "event_uses_procedure";

export type StorageState = "ephemeral" | "persisted" | "deleted";

/**
 * Entity reference in a context node
 */
export interface EntityRef {
  /** Entity ID (if matched to existing entity) */
  entityId?: number;
  /** Canonical name of the entity */
  name: string;
  /** Type of entity */
  entityType?: string;
  /** Confidence score (0-1) */
  confidence?: number;
}

/**
 * Expanded context node with full details
 */
export interface ExpandedContextNode {
  /** Node ID */
  id?: number;
  /** Node type */
  kind: ContextKind;
  /** Thread identifier (for events) */
  threadId?: string;
  /** Node title (≤100 chars) */
  title: string;
  /** Node summary (≤200 chars) */
  summary: string;
  /** Keywords for search */
  keywords: string[];
  /** Entity references */
  entities: EntityRef[];
  /** Importance score (0-10) */
  importance: number;
  /** Confidence score (0-10) */
  confidence: number;
  /** IDs of nodes merged into this one */
  mergedFromIds?: number[];
  /** Screenshot IDs linked to this node */
  screenshotIds: number[];
  /** Event timestamp */
  eventTime?: number;
  /** Creation timestamp */
  createdAt?: number;
}

/**
 * Search filters
 */
export interface SearchFilters {
  /** Time range filter */
  timeRange?: {
    start: number;
    end: number;
  };
  /** Filter by application */
  appHint?: string;
  /** Filter by entities */
  entities?: string[];
  /** Filter by thread */
  threadId?: string;
}

/**
 * Search query parameters
 */
export interface SearchQuery {
  requestId?: string;
  /** Natural language query */
  query: string;
  /** Optional filters */
  filters?: SearchFilters;
  /** Number of results to return */
  topK?: number;
  /** Enable Deep Search (LLM-enhanced query understanding + answer synthesis) */
  deepSearch?: boolean;
}

/**
 * Screenshot evidence in search results
 */
export interface ScreenshotEvidence {
  /** Screenshot ID */
  screenshotId: number;
  /** Capture timestamp */
  ts: number;
  /** File path (if available) */
  filePath?: string;
  /** Storage state */
  storageState: StorageState;
  /** Application hint */
  appHint?: string;
  /** Window title */
  windowTitle?: string;
}

// ============================================================================
// Deep Search Types (LLM-enhanced search)
// ============================================================================

/**
 * Query understanding result from LLM
 * Produces optimized embedding text and structured filters from natural language
 */
export interface SearchQueryPlan {
  /** Optimized text for embedding (normalized entities, clear intent) */
  embeddingText: string;
  /** Extracted filter constraints to merge with user-provided filters */
  filtersPatch?: Partial<SearchFilters>;
  /** Hint for result kind (used for ranking, not filtering) */
  kindHint?: "event" | "knowledge" | "state_snapshot" | "procedure" | "plan" | "entity_profile";
  /** Entities extracted from query */
  extractedEntities?: string[];
  /** Reasoning for time range extraction (debug only) */
  timeRangeReasoning?: string;
  /** Confidence score (0-1), low confidence = skip filtersPatch */
  confidence: number;
}

/**
 * Citation in a search answer
 */
export interface SearchAnswerCitation {
  /** Referenced node ID */
  nodeId?: number;
  /** Referenced screenshot ID */
  screenshotId?: number;
  /** Short quote/evidence (≤80 chars, no sensitive content) */
  quote?: string;
}

/**
 * Synthesized answer from LLM based on search results
 */
export interface SearchAnswer {
  /** Optional title for the answer */
  answerTitle?: string;
  /** Main answer text */
  answer: string;
  /** Key bullet points (≤8) */
  bullets?: string[];
  /** Citations referencing nodes/screenshots */
  citations: SearchAnswerCitation[];
  /** Confidence score (0-1) */
  confidence: number;
}

/**
 * Search result
 */
export interface SearchResult {
  /** Matched context nodes */
  nodes: ExpandedContextNode[];
  /** Related events for context */
  relatedEvents: ExpandedContextNode[];
  /** Screenshot evidence */
  evidence: ScreenshotEvidence[];
  /** Query understanding result (Deep Search only) */
  queryPlan?: SearchQueryPlan;
  /** Synthesized answer (Deep Search only) */
  answer?: SearchAnswer;
}

/**
 * Result of graph traversal
 */
export interface GraphTraversalResult {
  /** Nodes found during traversal */
  nodes: ExpandedContextNode[];
  /** Edges traversed */
  edges: Array<{
    fromId: number;
    toId: number;
    edgeType: EdgeType;
  }>;
  /** Screenshot IDs found */
  screenshotIds: number[];
}
