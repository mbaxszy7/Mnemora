/**
 * Shared Context Graph Types
 *
 * This file contains type definitions shared between the Electron main process
 * and the Renderer process for context graph operations.
 */

export const CONTEXT_KIND_VALUES = ["event", "knowledge", "state_snapshot"] as const;
export type ContextKind = (typeof CONTEXT_KIND_VALUES)[number];

export type EdgeType = never;

export type StorageState = "ephemeral" | "persisted" | "deleted";

export type ThreadStatus = "active" | "inactive" | "closed";

export interface Thread {
  id: string;
  title: string;
  summary: string;
  currentPhase?: string;
  currentFocus?: string;
  status: ThreadStatus;
  startTime: number;
  lastActiveAt: number;
  durationMs: number;
  nodeCount: number;
  apps: string[];
  mainProject?: string;
  keyEntities: string[];
  milestones?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AppContextPayload {
  appHint: string | null;
  windowTitle: string | null;
  sourceKey: string;
}

export interface KnowledgePayload {
  contentType: string;
  sourceUrl?: string;
  projectOrLibrary?: string;
  keyInsights: string[];
  language: "en" | "zh" | "other";
  textRegion?: {
    box: {
      top: number;
      left: number;
      width: number;
      height: number;
    };
    description?: string;
    confidence: number;
  };
}

export interface StateSnapshotPayload {
  subjectType: string;
  subject: string;
  currentState: string;
  metrics?: Record<string, string | number>;
  issue?: {
    detected: boolean;
    type: "error" | "bug" | "blocker" | "question" | "warning";
    description: string;
    severity: number;
  };
}

export interface ThreadSnapshot {
  threadId: string;
  title: string;
  summary: string;
  durationMs: number;
  startTime: number;
  lastActiveAt: number;
  currentPhase?: string | null;
  currentFocus?: string | null;
  mainProject?: string | null;
}

export interface ThreadSummary {
  id: string;
  title: string;
  summary: string;
  status: ThreadStatus;
  lastActiveAt: number;
  durationMs: number;
}

export const ENTITY_TYPE_VALUES = [
  "person",
  "project",
  "team",
  "org",
  "jira_id",
  "pr_id",
  "commit",
  "document_id",
  "url",
  "repo",
  "other",
] as const;

export type EntityType = (typeof ENTITY_TYPE_VALUES)[number];

/**
 * Entity reference in a context node
 */
export interface EntityRef {
  /** Canonical name of the entity */
  name: string;
  /** Type of entity */
  type: EntityType;
  /** Raw text span from source */
  raw?: string;
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
  /** Batch identifier */
  batchId: number;
  /** Thread identifier (for events) */
  threadId?: string;
  /** Thread snapshot payload */
  threadSnapshot?: ThreadSnapshot | null;
  /** Node title (≤100 chars) */
  title: string;
  /** Node summary (≤200 chars) */
  summary: string;
  /** App context */
  appContext: AppContextPayload;
  /** Extracted knowledge */
  knowledge: KnowledgePayload | null;
  /** Extracted state snapshot */
  stateSnapshot: StateSnapshotPayload | null;
  /** High-signal UI snippets */
  uiTextSnippets: string[];
  /** Keywords for search */
  keywords: string[];
  /** Named entities */
  entities: EntityRef[];
  /** Importance score (0-10) */
  importance: number;
  /** Confidence score (0-10) */
  confidence: number;
  /** Screenshot IDs linked to this node */
  screenshotIds: number[];
  /** Event timestamp */
  eventTime: number;
  /** Creation timestamp */
  createdAt?: number;
  /** Update timestamp */
  updatedAt?: number;
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
 * Search query text
 */
export type SearchQuery = string;

/**
 * Screenshot evidence in search results
 */
export interface ScreenshotEvidence {
  /** Screenshot ID */
  screenshotId: number;
  /** Capture timestamp */
  timestamp: number;
  /** Application hint */
  appHint?: string;
  /** Window title */
  windowTitle?: string;
  /** High-value UI text snippets */
  uiTextSnippets?: string[];
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
  kindHint?: ContextKind;
  /** Entities extracted from query */
  extractedEntities?: EntityRef[];
  /** Keywords extracted from query for exact matching */
  keywords?: string[];
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
export type GraphTraversalResult = never;
