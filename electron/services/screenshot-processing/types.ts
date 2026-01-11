/**
 * Screenshot Processing Types
 *
 * Core type definitions for the screenshot processing pipeline.
 * These types are used across all modules in the screenshot processing system.
 */

import type {
  ContextKind,
  EdgeType,
  VlmStatus,
  BatchStatus,
  EmbeddingStatus,
  IndexStatus,
  StorageState,
} from "../../database/schema";
import type {
  EntityRef,
  ExpandedContextNode,
  SearchQuery,
  SearchFilters,
  ScreenshotEvidence,
  SearchResult,
  GraphTraversalResult,
  SearchQueryPlan,
  SearchAnswer,
  SearchAnswerCitation,
} from "@shared/context-types";

// Re-export common types
export type {
  ContextKind,
  EdgeType,
  VlmStatus,
  BatchStatus,
  EmbeddingStatus,
  IndexStatus,
  StorageState,
  EntityRef,
  ExpandedContextNode,
  SearchQuery,
  SearchFilters,
  ScreenshotEvidence,
  SearchResult,
  GraphTraversalResult,
  SearchQueryPlan,
  SearchAnswer,
  SearchAnswerCitation,
};

// ============================================================================
// Source Key Types
// ============================================================================

/**
 * SourceKey identifies a capture source.
 * Format: `screen:<displayId>` for screen captures
 *         `window:<desktopCapturerSourceId>` for window captures
 */
export type SourceKey = `screen:${string}` | `window:${string}`;

/**
 * Type guard to check if a string is a valid SourceKey
 */
export function isValidSourceKey(key: string): key is SourceKey {
  return key.startsWith("screen:") || key.startsWith("window:");
}

// ============================================================================
// Screenshot Types
// ============================================================================

/**
 * Metadata associated with a screenshot
 */
export interface ScreenshotMeta {
  /** Application hint (e.g., app name) */
  appHint?: string;
  /** Window title */
  windowTitle?: string;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** File size in bytes */
  bytes?: number;
  /** MIME type (e.g., 'image/png') */
  mime?: string;
}

/**
 * A screenshot that has been accepted (passed deduplication)
 */
export interface AcceptedScreenshot {
  /** Database ID */
  id: number;
  /** Capture timestamp in milliseconds */
  ts: number;
  /** Source identifier */
  sourceKey: SourceKey;
  /** Perceptual hash for deduplication */
  phash: string;
  /** Path to the image file */
  filePath: string;
  /** Additional metadata */
  meta: ScreenshotMeta;
}

/**
 * Screenshot with base64 encoded image data (for VLM processing)
 */
export interface ScreenshotWithData extends AcceptedScreenshot {
  /** Base64 encoded image data */
  base64: string;
}

// ============================================================================
// Batch Types
// ============================================================================

/**
 * Processing status for batches and records
 */
export type ProcessingStatus = VlmStatus;

/**
 * A batch of screenshots for VLM processing
 */
export interface Batch {
  /** Unique batch identifier */
  batchId: string;
  /** Source identifier */
  sourceKey: SourceKey;
  /** Screenshots in this batch */
  screenshots: AcceptedScreenshot[];
  /** Processing status */
  status: BatchStatus;
  /** Idempotency key for deduplication */
  idempotencyKey: string;
  /** Start timestamp of the batch */
  tsStart: number;
  /** End timestamp of the batch */
  tsEnd: number;
  /** History context for VLM */
  historyPack?: HistoryPack;
}

// ============================================================================
// Shard Types
// ============================================================================

/**
 * A shard is a subset of a batch for parallel VLM processing
 */
export interface Shard {
  /** Index of this shard within the batch (0-based) */
  shardIndex: number;
  /** Screenshots in this shard */
  screenshots: ScreenshotWithData[];
  /** History context (shared across all shards in a batch) */
  historyPack: HistoryPack;
}

/**
 * Status of a single shard's processing
 */
export interface ShardStatus {
  /** Processing status */
  status: VlmStatus;
  /** Number of processing attempts */
  attempts: number;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// History Pack Types
// ============================================================================

/**
 * Summary of a recent thread for context
 */
export interface ThreadSummary {
  /** Thread identifier */
  threadId: string;
  /** Thread title */
  title: string;
  /** Summary of the last event (≤200 chars) */
  lastEventSummary: string;
  /** Timestamp of the last event */
  lastEventTs: number;
}

/**
 * Summary of an open (unclosed) segment
 */
export interface SegmentSummary {
  /** Segment identifier */
  segmentId: string;
  /** Brief summary of the segment */
  summary: string;
  /** Source key of the segment */
  sourceKey: SourceKey;
  /** Start timestamp */
  startTs: number;
}

/**
 * History pack provides context for VLM to detect activity continuity
 */
export interface HistoryPack {
  /** Recent threads (1-3) with their latest event summaries */
  recentThreads: ThreadSummary[];
  /** Open segments within the time window (e.g., 15 minutes) */
  openSegments: SegmentSummary[];
  /** Recently mentioned entities (5-10 canonical names) */
  recentEntities: string[];
}

// ============================================================================
// Entity Types
// ============================================================================

/**
 * Entity types that can be detected
 */
export type EntityType = string;
/**
 * A detected entity from OCR/VLM
 */
export interface DetectedEntity {
  /** Entity name as detected */
  name: string;
  /** Type of entity */
  entityType: EntityType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Source of detection */
  source: "ocr" | "vlm";
}

// ============================================================================
// Evidence Pack Types
// ============================================================================

/**
 * VLM index fragment for a specific screenshot
 */
export interface VLMIndexFragment {
  /** Segment ID this screenshot belongs to */
  segmentId: string;
  /** Event title from VLM */
  eventTitle: string;
  /** Event summary from VLM */
  eventSummary: string;
  /** Titles of derived nodes */
  derivedTitles: string[];
}

/**
 * Evidence pack stores minimal evidence for each screenshot
 * Used for retrieval even after image deletion
 */
export interface EvidencePack {
  /** Screenshot ID */
  screenshotId: number;
  /** Application hint */
  appHint?: string;
  /** Window title */
  windowTitle?: string;
  /** OCR extracted text (≤8k chars) */
  ocrText?: string;
  /** High-value UI text snippets (5-20 items) */
  uiTextSnippets?: string[];
  /** Detected entities with confidence */
  detectedEntities?: DetectedEntity[];
  /** VLM index fragment for this screenshot */
  vlmIndexFragment?: VLMIndexFragment;
}

// ============================================================================
// Context Node Types
// ============================================================================

// ============================================================================
// Pending Record Types (for Reconcile Loop)
// ============================================================================

/**
 * Tables that can have pending records
 */
export type PendingRecordTable =
  | "batches"
  | "context_nodes"
  | "vector_documents"
  | "activity_summaries"
  | "activity_events";

/**
 * A pending record that needs processing
 */
export interface PendingRecord {
  /** Record ID */
  id: number;
  /** Table name */
  table: PendingRecordTable;
  /** Current status */
  status: "pending" | "failed";
  /** Number of processing attempts */
  attempts: number;
  /** Next scheduled run time */
  nextRunAt?: number;
  /** Subtask type for tables with multiple disjoint separate processes (e.g. vector_documents) */
  subtask?: "embedding" | "index";

  createdAt?: number;
  updatedAt?: number;
}
