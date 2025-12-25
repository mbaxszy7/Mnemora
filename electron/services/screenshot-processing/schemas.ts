/**
 * Screenshot Processing Schemas
 *
 * Zod schemas for validating VLM/LLM outputs and other structured data.
 * These schemas ensure type safety and provide runtime validation.
 */

import { z } from "zod";

import { CONTEXT_KIND_VALUES, EDGE_TYPE_VALUES, VLM_STATUS_VALUES } from "../../database/schema";

// ============================================================================
// Context Kind and Edge Type Enums
// ============================================================================

/**
 * Context node kinds
 */
export const ContextKindEnum = z.enum([...CONTEXT_KIND_VALUES]);

export type ContextKindValue = z.infer<typeof ContextKindEnum>;

/**
 * Edge types for context graph relationships
 */
export const EdgeTypeEnum = z.enum([...EDGE_TYPE_VALUES]);

export type EdgeTypeValue = z.infer<typeof EdgeTypeEnum>;

/**
 * Entity types
 */
export const EntityTypeSchema = z.string().min(1).max(32);

export type EntityTypeValue = z.infer<typeof EntityTypeSchema>;

/**
 * Processing status values
 */
export const ProcessingStatusEnum = z.enum([...VLM_STATUS_VALUES]);

export type ProcessingStatusValue = z.infer<typeof ProcessingStatusEnum>;

/**
 * Merge decision values
 */
export const MergeDecisionEnum = z.enum(["NEW", "MERGE"]);

export type MergeDecisionValue = z.infer<typeof MergeDecisionEnum>;

// ============================================================================
// VLM Output Schemas
// ============================================================================

/**
 * Schema for derived items (knowledge, state, procedure, plan)
 */
export const DerivedItemSchema = z.object({
  /** Title of the derived item (≤100 chars) */
  title: z.string().max(100),
  /** Summary of the derived item (≤180 chars) */
  summary: z.string().max(180),
  /** Steps for procedures (optional) */
  steps: z.array(z.string().max(80)).optional(),
  /** Object being tracked for state snapshots (optional) */
  object: z.string().optional(),
});

export type DerivedItem = z.infer<typeof DerivedItemSchema>;

/**
 * Schema for VLM segment event
 */
export const VLMEventSchema = z.object({
  /** Event title (≤100 chars) */
  title: z.string().max(100),
  /** Event summary (≤200 chars) */
  summary: z.string().max(200),
  /** Confidence score (0-10) */
  confidence: z.number().min(0).max(10),
  /** Importance score (0-10) */
  importance: z.number().min(0).max(10),
});

export type VLMEvent = z.infer<typeof VLMEventSchema>;

/**
 * Schema for derived nodes in a segment
 */
export const DerivedNodesSchema = z.object({
  /** Knowledge items extracted */
  knowledge: z.array(DerivedItemSchema).max(2).default([]),
  /** State snapshots captured */
  state: z.array(DerivedItemSchema).max(2).default([]),
  /** Procedures identified */
  procedure: z.array(DerivedItemSchema).max(2).default([]),
  /** Plans detected */
  plan: z.array(DerivedItemSchema).max(2).default([]),
});

export type DerivedNodes = z.infer<typeof DerivedNodesSchema>;

/**
 * Schema for merge hint
 */
export const MergeHintSchema = z
  .object({
    /** Decision: NEW for new thread, MERGE for existing thread */
    decision: MergeDecisionEnum,
    /** Thread ID to merge with (required if decision is MERGE) */
    thread_id: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.decision === "MERGE" && !val.thread_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thread_id"],
        message: "thread_id is required when decision is MERGE",
      });
    }
  });

export type MergeHint = z.infer<typeof MergeHintSchema>;

/**
 * Schema for a VLM segment
 */
export const VLMSegmentSchema = z.object({
  /** Unique segment identifier */
  segment_id: z.string(),
  /** Screenshot IDs (1-based indices) included in this segment */
  screen_ids: z.array(z.number().int().positive()),
  /** Event information */
  event: VLMEventSchema,
  /** Derived nodes */
  derived: DerivedNodesSchema,
  /** Merge hint for thread continuity */
  merge_hint: MergeHintSchema,
  /** Keywords for search (optional) */
  keywords: z.array(z.string()).max(10).optional(),
});

export type VLMSegment = z.infer<typeof VLMSegmentSchema>;

/**
 * Schema for complete VLM index result
 */
export const VLMIndexResultSchema = z.object({
  /** Segments extracted from the batch (max 4) */
  segments: z.array(VLMSegmentSchema).max(4),
  /** Entities mentioned across all segments (max 20) */
  entities: z.array(z.string()).max(20).default([]),
  /** Per-screenshot OCR results */
  screenshots: z
    .array(
      z.object({
        /** Screenshot database ID (must match screenshot_id in the input metadata) */
        screenshot_id: z.number().int().positive(),
        /** Full OCR text (trimmed, ≤8000 chars) */
        ocr_text: z.string().max(8000).optional(),
        /** High-value UI text snippets (≤20, each ≤200 chars) */
        ui_text_snippets: z.array(z.string().max(200)).max(20).optional(),
      })
    )
    .default([]),
  /** Optional notes from VLM */
  notes: z.string().optional(),
});

export type VLMIndexResult = z.infer<typeof VLMIndexResultSchema>;

// ============================================================================
// Meta Payload Schema
// ============================================================================

/**
 * Schema for vector document meta payload
 * Used for post-retrieval filtering
 */
export const MetaPayloadSchema = z.object({
  /** Node kind */
  kind: ContextKindEnum,
  /** Thread ID (for events) */
  thread_id: z.string().optional(),
  /** Timestamp */
  ts: z.number(),
  /** Application hint */
  app_hint: z.string().optional(),
  /** Entity names mentioned */
  entities: z.array(z.string()).default([]),
  /** Source key */
  source_key: z.string(),
});

export type MetaPayload = z.infer<typeof MetaPayloadSchema>;

// ============================================================================
// Screenshot Meta Schema
// ============================================================================

/**
 * Schema for screenshot metadata passed to VLM
 * Note: Named VLMScreenshotMeta to avoid conflict with types.ts ScreenshotMeta
 */
export const VLMScreenshotMetaSchema = z.object({
  /** 1-based index in the batch */
  index: z.number().int().positive(),
  /** Screenshot database ID */
  screenshot_id: z.number().int().positive(),
  /** Capture timestamp (ISO string) */
  captured_at: z.string(),
  /** Source key */
  source_key: z.string(),
  /** Application hint (null if unavailable) */
  app_hint: z.string().nullable(),
  /** Window title (null if unavailable) */
  window_title: z.string().nullable(),
});

export type VLMScreenshotMeta = z.infer<typeof VLMScreenshotMetaSchema>;

// ============================================================================
// History Pack Schema
// ============================================================================

/**
 * Schema for thread summary in history pack
 */
export const ThreadSummarySchema = z.object({
  /** Thread identifier */
  thread_id: z.string(),
  /** Thread title */
  title: z.string().max(100),
  /** Last event summary (≤200 chars) */
  last_event_summary: z.string().max(200),
  /** Last event timestamp */
  last_event_ts: z.number(),
});

export type ThreadSummaryValue = z.infer<typeof ThreadSummarySchema>;

/**
 * Schema for segment summary in history pack
 */
export const SegmentSummarySchema = z.object({
  /** Segment identifier */
  segment_id: z.string(),
  /** Segment summary */
  summary: z.string().max(200),
  /** Source key */
  source_key: z.string(),
  /** Start timestamp */
  start_ts: z.number(),
});

export type SegmentSummaryValue = z.infer<typeof SegmentSummarySchema>;

/**
 * Schema for history pack
 */
export const HistoryPackSchema = z.object({
  /** Recent threads (1-3) */
  recent_threads: z.array(ThreadSummarySchema).max(3).default([]),
  /** Open segments */
  open_segments: z.array(SegmentSummarySchema).default([]),
  /** Recent entity names (5-10) */
  recent_entities: z.array(z.string()).max(10).default([]),
});

export type HistoryPackValue = z.infer<typeof HistoryPackSchema>;

// ============================================================================
// Entity Schemas
// ============================================================================

/**
 * Schema for entity reference
 */
export const EntityRefSchema = z.object({
  /** Entity ID (if matched) */
  entity_id: z.number().int().positive().optional(),
  /** Entity name */
  name: z.string(),
  /** Entity type */
  entity_type: EntityTypeSchema.optional(),
  /** Confidence score (0-1) */
  confidence: z.number().min(0).max(1).optional(),
});

export type EntityRefValue = z.infer<typeof EntityRefSchema>;

/**
 * Schema for detected entity
 */
export const DetectedEntitySchema = z.object({
  /** Entity name */
  name: z.string(),
  /** Entity type */
  entity_type: EntityTypeSchema,
  /** Confidence score (0-1) */
  confidence: z.number().min(0).max(1),
  /** Detection source */
  source: z.enum(["ocr", "vlm"]),
});

export type DetectedEntityValue = z.infer<typeof DetectedEntitySchema>;

// ============================================================================
// Text LLM Expand Output Schema
// ============================================================================

/**
 * Schema for expanded context node from Text LLM
 */
export const ExpandedNodeSchema = z.object({
  /** Node kind */
  kind: ContextKindEnum,
  /** Thread ID */
  thread_id: z.string().optional(),
  /** Title (≤100 chars) */
  title: z.string().max(100),
  /** Summary (≤200 chars) */
  summary: z.string().max(200),
  /** Keywords */
  keywords: z.array(z.string()).max(10).default([]),
  /** Entity references */
  entities: z.array(EntityRefSchema).default([]),
  /** Importance (0-10) */
  importance: z.number().min(0).max(10),
  /** Confidence (0-10) */
  confidence: z.number().min(0).max(10),
  /** Screenshot IDs */
  screenshot_ids: z.array(z.number().int().positive()).default([]),
  /** Event timestamp */
  event_time: z.number().optional(),
});

export type ExpandedNode = z.infer<typeof ExpandedNodeSchema>;

/**
 * Schema for Text LLM expand result
 */
export const TextLLMExpandResultSchema = z.object({
  /** Expanded nodes */
  nodes: z.array(ExpandedNodeSchema),
  /** Edges to create */
  edges: z
    .array(
      z.object({
        from_index: z.number().int().min(0),
        to_index: z.number().int().min(0),
        edge_type: EdgeTypeEnum,
      })
    )
    .default([]),
});

export type TextLLMExpandResult = z.infer<typeof TextLLMExpandResultSchema>;

// ============================================================================
// Activity Summary Schema
// ============================================================================

/**
 * Schema for activity summary metadata
 */
export const ActivitySummaryMetadataSchema = z.object({
  /** Number of nodes included */
  node_count: z.number().int().min(0),
  /** Thread IDs included */
  thread_ids: z.array(z.string()).default([]),
  /** Top entities mentioned */
  top_entities: z.array(z.string()).default([]),
});

export type ActivitySummaryMetadata = z.infer<typeof ActivitySummaryMetadataSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Safely parse VLM index result with error handling
 */
export function parseVLMIndexResult(data: unknown): {
  success: boolean;
  data?: VLMIndexResult;
  error?: z.ZodError;
} {
  const result = VLMIndexResultSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safely parse meta payload with error handling
 */
export function parseMetaPayload(data: unknown): {
  success: boolean;
  data?: MetaPayload;
  error?: z.ZodError;
} {
  const result = MetaPayloadSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safely parse Text LLM expand result with error handling
 */
export function parseTextLLMExpandResult(data: unknown): {
  success: boolean;
  data?: TextLLMExpandResult;
  error?: z.ZodError;
} {
  const result = TextLLMExpandResultSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validate that a string is valid JSON and parse it
 */
export function extractAndParseJSON<T>(
  rawText: string,
  schema: z.ZodSchema<T>
): { success: boolean; data?: T; error?: string } {
  // Try to extract JSON from the text (handle markdown code blocks)
  let jsonStr = rawText.trim();

  // Remove markdown code block if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try to find JSON object or array
  const jsonMatch = jsonStr.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch) {
    return { success: false, error: "No JSON object or array found in text" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: `Schema validation failed: ${result.error.message}`,
    };
  } catch (e) {
    return {
      success: false,
      error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
