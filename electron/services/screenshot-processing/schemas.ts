/**
 * Screenshot Processing Schemas
 *
 * Zod schemas for validating VLM/LLM outputs and other structured data.
 * These schemas ensure type safety and provide runtime validation.
 */

import { z } from "zod";

import { CONTEXT_KIND_VALUES, EDGE_TYPE_VALUES, VLM_STATUS_VALUES } from "../../database/schema";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "../screen-capture/types";

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
// Constants
// ============================================================================

const CANONICAL_APP_CANDIDATES = Object.keys(DEFAULT_WINDOW_FILTER_CONFIG.appAliases);
const ALLOWED_APP_GUESSES: [string, ...string[]] = [
  "unknown",
  "other",
  ...CANONICAL_APP_CANDIDATES,
];

// ============================================================================
// VLM Output Schemas
// ============================================================================

/**
 * Helper to create a string schema that truncates instead of rejecting.
 * Use for post-processing.
 */
function truncateTo(maxLen: number) {
  return (s: string) => (s.length > maxLen ? s.slice(0, maxLen) : s);
}

/**
 * Schema for derived items (knowledge, state, procedure, plan)
 */
export const DerivedItemSchema = z.object({
  /** Title of the derived item (≤100 chars) */
  title: z.string().max(100),
  /** Summary of the derived item (≤500 chars) */
  summary: z.string().max(500),
  /** Steps for procedures (optional) */
  steps: z.array(z.string()).optional(),
  /** Object being tracked for state snapshots (optional) */
  object: z.string().optional(),
});

export const DerivedItemProcessedSchema = DerivedItemSchema.transform((val) => {
  const result: z.infer<typeof DerivedItemSchema> = {
    ...val,
    title: truncateTo(100)(val.title),
    summary: truncateTo(500)(val.summary),
  };
  if (val.steps) {
    result.steps = val.steps.map(truncateTo(80));
  }
  return result;
});

export type DerivedItem = z.infer<typeof DerivedItemSchema>;

/**
 * Schema for VLM segment event
 */
export const VLMEventSchema = z.object({
  /** Event title (≤100 chars) */
  title: z.string().max(100),
  /** Event summary (≤500 chars) */
  summary: z.string().max(500),
  /** Confidence score (0-10) */
  confidence: z.number().min(0).max(10),
  /** Importance score (0-10) */
  importance: z.number().min(0).max(10),
});

export const VLMEventProcessedSchema = VLMEventSchema.transform((val) => ({
  ...val,
  title: truncateTo(100)(val.title),
  summary: truncateTo(500)(val.summary),
  confidence: Math.max(0, Math.min(10, val.confidence)),
  importance: Math.max(0, Math.min(10, val.importance)),
}));

export type VLMEvent = z.infer<typeof VLMEventProcessedSchema>;

/**
 * Schema for derived nodes in a segment
 */
export const DerivedNodesSchema = z.object({
  /** Knowledge items extracted */
  knowledge: z.array(DerivedItemSchema).default([]),
  /** State snapshots captured */
  state: z.array(DerivedItemSchema).default([]),
  /** Procedures identified */
  procedure: z.array(DerivedItemSchema).default([]),
  /** Plans detected */
  plan: z.array(DerivedItemSchema).default([]),
});

export const DerivedNodesProcessedSchema = DerivedNodesSchema.transform((val) => {
  const result: z.infer<typeof DerivedNodesSchema> = {
    knowledge: val.knowledge.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
    state: val.state.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
    procedure: val.procedure.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
    plan: val.plan.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
  };
  return result;
});

export type DerivedNodes = z.infer<typeof DerivedNodesSchema>;

/**
 * Schema for merge hint
 */
export const MergeHintSchema = z.object({
  /** Decision: NEW for new thread, MERGE for existing thread */
  decision: MergeDecisionEnum,
  /** Thread ID to merge with (required if decision is MERGE) */
  thread_id: z.string().optional(),
});

export const MergeHintProcessedSchema = MergeHintSchema.refine(
  (val) => !(val.decision === "MERGE" && !val.thread_id),
  {
    message: "thread_id is required when decision is MERGE",
    path: ["thread_id"],
  }
);

export type MergeHint = z.infer<typeof MergeHintProcessedSchema>;

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
  keywords: z.array(z.string()).optional(),
});

export const VLMSegmentProcessedSchema = VLMSegmentSchema.transform((val) => {
  const result: z.infer<typeof VLMSegmentSchema> = {
    ...val,
    event: VLMEventProcessedSchema.parse(val.event),
    derived: DerivedNodesProcessedSchema.parse(val.derived),
    merge_hint: MergeHintProcessedSchema.parse(val.merge_hint),
  };
  if (val.keywords) {
    result.keywords = val.keywords.slice(0, 10);
  }
  return result;
});

export type VLMSegment = z.infer<typeof VLMSegmentSchema>;

/**
 * Schema for complete VLM index result
 */
export const VLMIndexResultSchema = z.object({
  /** Segments extracted from the batch (max 4) */
  segments: z.array(VLMSegmentSchema),
  /** Entities mentioned across all segments (max 20) */
  entities: z.array(z.string()).default([]),
  /** Per-screenshot OCR results */
  screenshots: z
    .array(
      z.object({
        /** Screenshot database ID (must match screenshot_id in the input metadata) */
        screenshot_id: z.number().int().positive(),
        app_guess: z
          .object({
            name: z.enum(ALLOWED_APP_GUESSES as [string, ...string[]]),
            confidence: z.number(),
          })
          .optional(),
        /** Full OCR text (trimmed, ≤8000 chars) */
        ocr_text: z.string().optional(),
        /** High-value UI text snippets (≤20, each ≤200 chars) */
        ui_text_snippets: z.array(z.string().max(200)).optional(),
      })
    )
    .default([]),
  /** Optional notes from VLM */
  notes: z.string().optional(),
});

export const VLMIndexResultProcessedSchema = VLMIndexResultSchema.transform((val) => {
  const result: z.infer<typeof VLMIndexResultSchema> = {
    ...val,
    segments: val.segments.slice(0, 4).map((s) => VLMSegmentProcessedSchema.parse(s)),
    entities: val.entities.slice(0, 20),
    screenshots: val.screenshots.map((s) => {
      const ss: z.infer<typeof VLMIndexResultSchema>["screenshots"][number] = { ...s };
      if (s.app_guess) {
        ss.app_guess = {
          name: truncateTo(100)(s.app_guess.name),
          confidence: Math.max(0, Math.min(1, s.app_guess.confidence)),
        };
      }
      if (s.ocr_text) {
        ss.ocr_text = truncateTo(8000)(s.ocr_text);
      }
      if (s.ui_text_snippets) {
        ss.ui_text_snippets = s.ui_text_snippets.slice(0, 20).map(truncateTo(200));
      }
      return ss;
    }),
  };
  return result;
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
  confidence: z.number().optional(),
});

export const EntityRefProcessedSchema = EntityRefSchema.transform((val) => ({
  ...val,
  confidence: val.confidence !== undefined ? Math.max(0, Math.min(1, val.confidence)) : undefined,
}));

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
  /** Title (LLM may exceed 100, we truncate later) */
  title: z.string(),
  /** Summary (LLM may exceed 200, we truncate later) */
  summary: z.string(),
  /** Keywords */
  keywords: z.array(z.string()).default([]),
  /** Entity references */
  entities: z.array(EntityRefSchema).default([]),
  /** Importance (0-10) */
  importance: z.number().default(5),
  /** Confidence (0-10) */
  confidence: z.number().default(5),
  /** Screenshot IDs */
  screenshot_ids: z.array(z.number().int().positive()).default([]),
  /** Event timestamp */
  event_time: z.number().optional(),
});

export const ExpandedNodeProcessedSchema = ExpandedNodeSchema.transform((val) => {
  return {
    ...val,
    title: truncateTo(100)(val.title),
    summary: truncateTo(200)(val.summary),
    keywords: (val.keywords ?? []).slice(0, 10),
    importance: Math.max(0, Math.min(10, Math.round(val.importance))),
    confidence: Math.max(0, Math.min(10, Math.round(val.confidence))),
    entities: (val.entities ?? []).map((e) => EntityRefProcessedSchema.parse(e)),
  };
});

export type ExpandedNode = z.infer<typeof ExpandedNodeProcessedSchema>;

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

export const TextLLMExpandResultProcessedSchema = TextLLMExpandResultSchema.transform((val) => {
  return {
    ...val,
    nodes: val.nodes.map((n) => ExpandedNodeProcessedSchema.parse(n)),
  };
});

export type TextLLMExpandResult = z.infer<typeof TextLLMExpandResultProcessedSchema>;

/**
 * Schema for Text LLM merge result (subset of ExpandedNode)
 */
export const TextLLMMergeResultSchema = z.object({
  title: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()).default([]),
  entities: z.array(EntityRefSchema).default([]),
});

export const TextLLMMergeResultProcessedSchema = TextLLMMergeResultSchema.transform((val) => {
  return {
    ...val,
    title: truncateTo(100)(val.title),
    summary: truncateTo(200)(val.summary),
    keywords: (val.keywords ?? []).slice(0, 10),
    entities: (val.entities ?? []).map((e) => EntityRefProcessedSchema.parse(e)),
  };
});

export type TextLLMMergeResult = z.infer<typeof TextLLMMergeResultProcessedSchema>;

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
  const result = VLMIndexResultProcessedSchema.safeParse(data);
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
  const result = TextLLMExpandResultProcessedSchema.safeParse(data);
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
// ============================================================================
// Activity Monitor LLM Output Schemas
// ============================================================================

/**
 * Event candidate from LLM window analysis
 */
export const ActivityEventCandidateSchema = z.object({
  title: z.string().max(100),
  kind: z.enum(["focus", "work", "meeting", "break", "browse", "coding"]),
  start_offset_min: z.number().min(0).max(20),
  end_offset_min: z.number().min(0).max(20),
  confidence: z.number().min(0).max(10),
  importance: z.number().min(0).max(10),
  description: z.string().max(200),
  node_ids: z.array(z.number().int().positive()),
});

export type ActivityEventCandidate = z.infer<typeof ActivityEventCandidateSchema>;

/**
 * Schema for LLM-generated window summary
 */
export const ActivityWindowSummaryLLMSchema = z.object({
  title: z.string(),
  summary: z.string(), // Markdown with four fixed sections
  highlights: z.array(z.string()).max(5),
  stats: z.object({
    top_apps: z.array(z.string()).max(5),
    top_entities: z.array(z.string()).max(5),
  }),
  events: z.array(ActivityEventCandidateSchema),
});

export const ActivityWindowSummaryLLMProcessedSchema = ActivityWindowSummaryLLMSchema.transform(
  (val) => ({
    ...val,
    title: truncateTo(100)(val.title),
    highlights: val.highlights.map(truncateTo(100)),
  })
);

export type ActivityWindowSummaryLLM = z.infer<typeof ActivityWindowSummaryLLMProcessedSchema>;

/**
 * Schema for LLM-generated event details
 */
export const ActivityEventDetailsLLMSchema = z.object({
  details: z.string(), // Markdown detailed report
});

export const ActivityEventDetailsLLMProcessedSchema = ActivityEventDetailsLLMSchema;

export type ActivityEventDetailsLLM = z.infer<typeof ActivityEventDetailsLLMProcessedSchema>;

/**
 * Safely parse Activity Window Summary LLM result
 */
export function parseActivityWindowSummaryLLM(data: unknown): {
  success: boolean;
  data?: ActivityWindowSummaryLLM;
  error?: z.ZodError;
} {
  const result = ActivityWindowSummaryLLMProcessedSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safely parse Activity Event Details LLM result
 */
export function parseActivityEventDetailsLLM(data: unknown): {
  success: boolean;
  data?: ActivityEventDetailsLLM;
  error?: z.ZodError;
} {
  const result = ActivityEventDetailsLLMProcessedSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ============================================================================
// Deep Search Schemas
// ============================================================================

/**
 * Schema for search query plan from LLM
 */
export const SearchQueryPlanSchema = z.object({
  embeddingText: z.string().min(1),
  filtersPatch: z
    .object({
      timeRange: z
        .object({
          start: z.number(),
          end: z.number(),
        })
        .optional(),
      appHint: z.string().optional(),
      entities: z.array(z.string()).optional(),
    })
    .optional(),
  kindHint: z
    .enum(["event", "knowledge", "state_snapshot", "procedure", "plan", "entity_profile"])
    .optional(),
  extractedEntities: z.array(z.string()).optional(),
  timeRangeReasoning: z.string().optional(),
  confidence: z.number(),
});

export const SearchQueryPlanProcessedSchema = SearchQueryPlanSchema.transform((val) => {
  const result: z.infer<typeof SearchQueryPlanSchema> = { ...val };
  if (val.filtersPatch?.appHint && !CANONICAL_APP_CANDIDATES.includes(val.filtersPatch.appHint)) {
    // Silently remove non-canonical appHint or could refine and throw
    if (result.filtersPatch) {
      delete result.filtersPatch.appHint;
    }
  }
  if (val.filtersPatch?.entities) {
    if (result.filtersPatch) {
      result.filtersPatch.entities = val.filtersPatch.entities.slice(0, 20);
    }
  }
  if (val.extractedEntities) {
    result.extractedEntities = val.extractedEntities.slice(0, 20);
  }
  result.confidence = Math.max(0, Math.min(1, val.confidence));
  return result;
});

export type SearchQueryPlanResult = z.infer<typeof SearchQueryPlanSchema>;

/**
 * Citation schema for search answers
 */
export const SearchAnswerCitationSchema = z.object({
  nodeId: z.number().int().positive().optional(),
  screenshotId: z.number().int().positive().optional(),
  quote: z.string().optional(),
});

/**
 * Schema for search answer from LLM
 */
export const SearchAnswerSchema = z.object({
  answerTitle: z.string().optional(),
  answer: z.string().min(1),
  bullets: z.array(z.string()).optional(),
  citations: z.array(SearchAnswerCitationSchema).default([]),
  followUps: z.array(z.string()).optional(),
  confidence: z.number(),
});

export const SearchAnswerProcessedSchema = SearchAnswerSchema.transform((val) => {
  const result: z.infer<typeof SearchAnswerSchema> = { ...val };
  result.confidence = Math.max(0, Math.min(1, val.confidence));
  if (val.bullets) {
    result.bullets = val.bullets.slice(0, 8);
  }
  if (val.citations) {
    result.citations = val.citations.slice(0, 20);
  }
  if (val.followUps) {
    result.followUps = val.followUps.slice(0, 5);
  }

  // Cross-field validation: if high confidence but no citations, lower confidence
  if (result.confidence > 0.2 && result.citations.length === 0) {
    result.confidence = 0.2;
  }

  return result;
});

export type SearchAnswerResult = z.infer<typeof SearchAnswerSchema>;
