/**
 * Screenshot Processing Schemas
 *
 * Zod schemas for validating VLM/LLM outputs and other structured data.
 * These schemas ensure type safety and provide runtime validation.
 */

import { z } from "zod";

import { CONTEXT_KIND_VALUES, EDGE_TYPE_VALUES } from "../../database/schema";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "../screen-capture/types";

// ============================================================================
// Context Kind and Edge Type Enums
// ============================================================================

/**
 * Context node kinds
 */
const ContextKindEnum = z.enum([...CONTEXT_KIND_VALUES]);

/**
 * Edge types for context graph relationships
 */
const EdgeTypeEnum = z.enum([...EDGE_TYPE_VALUES]);

/**
 * Entity types
 */
const EntityTypeSchema = z.string().min(1).max(32);

/**
 * Merge decision values
 */
const MergeDecisionEnum = z.enum(["NEW", "MERGE"]);

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
const DerivedItemSchema = z.object({
  title: z.string(),
  /** Summary of the derived item (≤500 chars) */
  summary: z.string(),
  /** Steps for procedures (optional) */
  steps: z.array(z.string().max(80)).optional(),
  /** Object being tracked for state snapshots (optional) */
  object: z.string().optional(),
});

const DerivedItemProcessedSchema = DerivedItemSchema.transform((val) => {
  const result: z.infer<typeof DerivedItemSchema> = {
    ...val,
    title: truncateTo(200)(val.title),
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
const VLMEventSchema = z.object({
  title: z.string(),
  /** Event summary (≤500 chars) */
  summary: z.string(),
  /** Confidence score (0-10) */
  confidence: z.number(),
  /** Importance score (0-10) */
  importance: z.number(),
});

const VLMEventProcessedSchema = VLMEventSchema.transform((val) => ({
  ...val,
  title: truncateTo(200)(val.title),
  summary: truncateTo(500)(val.summary),
  confidence: Math.max(0, Math.min(10, val.confidence)),
  importance: Math.max(0, Math.min(10, val.importance)),
}));

/**
 * Schema for derived nodes in a segment
 */
const DerivedNodesSchema = z.object({
  /** Knowledge items extracted */
  knowledge: z.array(DerivedItemSchema).default([]),
  /** State snapshots captured */
  state: z.array(DerivedItemSchema).default([]),
  /** Procedures identified */
  procedure: z.array(DerivedItemSchema).default([]),
  /** Plans detected */
  plan: z.array(DerivedItemSchema).default([]),
});

const DerivedNodesProcessedSchema = DerivedNodesSchema.transform((val) => {
  const result: z.infer<typeof DerivedNodesSchema> = {
    knowledge: val.knowledge.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
    state: val.state.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
    procedure: val.procedure.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
    plan: val.plan.slice(0, 2).map((item) => DerivedItemProcessedSchema.parse(item)),
  };
  return result;
});

/**
 * Schema for merge hint
 */
const MergeHintSchema = z.object({
  /** Decision: NEW for new thread, MERGE for existing thread */
  decision: MergeDecisionEnum,
  /** Thread ID to merge with (required if decision is MERGE) */
  thread_id: z.string().optional(),
});

const MergeHintProcessedSchema = MergeHintSchema.transform((val) => {
  if (val.decision === "MERGE" && !val.thread_id) {
    // Gracefully downgrade to NEW when thread_id is missing to avoid hard failure
    return { decision: "NEW" as const };
  }
  return val;
});

/**
 * Schema for a VLM segment
 */
const VLMSegmentSchema = z.object({
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

const VLMSegmentProcessedSchema = VLMSegmentSchema.transform((val) => {
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
        screenshot_id: z.coerce.number().int().positive(),
        app_guess: z
          .object({
            name: z.string(),
            confidence: z.number(),
          })
          .optional(),
        /** Full OCR text (trimmed, ≤8000 chars) */
        ocr_text: z.string().optional(),
        /** High-value UI text snippets (≤20, each ≤200 chars) */
        ui_text_snippets: z.array(z.string().nullable()).optional(),
      })
    )
    .default([]),
  /** Optional notes from VLM */
  notes: z.string().nullish(),
});

export const VLMIndexResultProcessedSchema = VLMIndexResultSchema.transform((val) => {
  const result: z.infer<typeof VLMIndexResultSchema> = {
    ...val,
    segments: val.segments.slice(0, 4).map((s) => VLMSegmentProcessedSchema.parse(s)),
    entities: val.entities.slice(0, 20),
    screenshots: val.screenshots.map((s) => {
      const ss: z.infer<typeof VLMIndexResultSchema>["screenshots"][number] = { ...s };
      if (s.app_guess) {
        let normalizedName = s.app_guess.name;
        // Try to match canonical name if possible
        const lowerName = s.app_guess.name.toLowerCase();
        for (const candidate of ALLOWED_APP_GUESSES) {
          if (candidate.toLowerCase() === lowerName) {
            normalizedName = candidate;
            break;
          }
        }
        ss.app_guess = {
          name: truncateTo(100)(normalizedName),
          confidence: Math.max(0, Math.min(1, s.app_guess.confidence)),
        };
      }
      if (s.ocr_text) {
        ss.ocr_text = truncateTo(8000)(s.ocr_text);
      }
      if (s.ui_text_snippets) {
        ss.ui_text_snippets = (Array.isArray(s.ui_text_snippets) ? s.ui_text_snippets : [])
          .filter((v): v is string => typeof v === "string")
          .slice(0, 20)
          .map(truncateTo(200));
      }
      return ss;
    }),
  };
  return result;
});

export type VLMIndexResult = z.infer<typeof VLMIndexResultSchema>;

export type VLMScreenshotMeta = {
  index: number;
  screenshot_id: number;
  captured_at: string;
  source_key: string;
  app_hint: string | null;
  window_title: string | null;
};

// ============================================================================
// Entity Schemas
// ============================================================================

/**
 * Schema for entity reference
 */
const EntityRefSchema = z.object({
  /** Entity ID (if matched) */
  entityId: z.number().int().positive().optional(),
  /** Entity name */
  name: z.string(),
  /** Entity type */
  entityType: EntityTypeSchema.optional(),
  /** Confidence score (0-1) */
  confidence: z.number().optional(),
});

const EntityRefProcessedSchema = EntityRefSchema.transform((val) => ({
  ...val,
  confidence: val.confidence !== undefined ? Math.max(0, Math.min(1, val.confidence)) : undefined,
}));

// ============================================================================
// Text LLM Expand Output Schema
// ============================================================================

/**
 * Schema for expanded context node from Text LLM
 */
const ExpandedNodeSchema = z.object({
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

const ExpandedNodeProcessedSchema = ExpandedNodeSchema.transform((val) => {
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
// Activity Monitor LLM Output Schemas
// ============================================================================

/**
 * Event candidate from LLM window analysis
 */
const ActivityEventCandidateSchema = z.object({
  title: z.string(),
  kind: z.enum(["focus", "work", "meeting", "break", "browse", "coding", "debugging"]),
  // LLM-provided minute offsets relative to the current windowStart (0..windowDurationMinutes)
  start_offset_min: z.number().min(0).max(20),
  end_offset_min: z.number().min(0).max(20),
  confidence: z.number().min(0).max(10),
  importance: z.number().min(0).max(10),
  description: z.string(),
  node_ids: z.array(z.number().int().positive()),
});

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

/**
 * Schema for LLM-generated event details
 */
export const ActivityEventDetailsLLMSchema = z.object({
  details: z.string(), // Markdown detailed report
});

export const ActivityEventDetailsLLMProcessedSchema = ActivityEventDetailsLLMSchema;

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
  extractedEntities: z.array(EntityRefSchema).optional(),
  keywords: z.array(z.string()).optional(),
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

/**
 * Citation schema for search answers
 */
const SearchAnswerCitationSchema = z.object({
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

  // Cross-field validation: if high confidence but no citations, lower confidence
  if (result.confidence > 0.2 && result.citations.length === 0) {
    result.confidence = 0.2;
  }

  return result;
});
