import { z } from "zod";

import { DEFAULT_WINDOW_FILTER_CONFIG } from "../screen-capture/types";
import { CONTEXT_KIND_VALUES, ENTITY_TYPE_VALUES, type EntityRef } from "@shared/context-types";

// =========================================================================
// VLM Output Schemas (Alpha - One Node per Screenshot)
// =========================================================================

function normalizeProjectKey(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const s = val.trim();
  if (!s || s.toLowerCase() === "null") return null;
  const key = s
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._\-/]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return key ? key : null;
}

export const EntityTypeSchema = z.preprocess((val) => {
  if (typeof val === "string" && (ENTITY_TYPE_VALUES as readonly string[]).includes(val)) {
    return val;
  }
  return "other";
}, z.enum(ENTITY_TYPE_VALUES));

export const EntityRefSchema: z.ZodType<EntityRef> = z.object({
  name: z.string(),
  type: EntityTypeSchema,
  raw: z.string().optional(),
  confidence: z.number().optional(),
});

const normalizeEntityRefs = (
  entities: z.infer<typeof EntityRefSchema>[],
  limit: number
): z.infer<typeof EntityRefSchema>[] => {
  const normalized: z.infer<typeof EntityRefSchema>[] = [];

  for (const entity of entities) {
    const name = entity.name.trim();
    if (!name) {
      continue;
    }

    const normalizedEntity: z.infer<typeof EntityRefSchema> = {
      name,
      type: entity.type,
    };

    if (entity.raw) {
      normalizedEntity.raw = entity.raw.trim();
    }

    if (entity.confidence !== undefined) {
      normalizedEntity.confidence = Math.max(0, Math.min(1, entity.confidence));
    }

    normalized.push(normalizedEntity);
    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
};

const normalizeEntityNames = (entities?: string[], limit = 20): string[] | undefined => {
  if (!entities) {
    return undefined;
  }

  const normalized = entities
    .map((entity) => entity.trim())
    .filter((entity) => entity.length > 0)
    .slice(0, limit);

  return normalized.length > 0 ? normalized : undefined;
};

export const CANONICAL_APP_CANDIDATES = Object.keys(DEFAULT_WINDOW_FILTER_CONFIG.appAliases);

export const KnowledgeSchema = z
  .object({
    content_type: z.string().default("general"),
    source_url: z.string().optional(),
    project_or_library: z.string().optional(),
    key_insights: z.array(z.string()).default([]),
    language: z.preprocess(
      (val) => {
        if (typeof val !== "string") return "other";
        const s = val.toLowerCase();
        if (s.includes("en")) return "en";
        if (s.includes("zh") || s.includes("cn") || s.includes("中文")) return "zh";
        return "other";
      },
      z.enum(["en", "zh", "other"])
    ),
    text_region: z
      .preprocess(
        (val) => {
          if (typeof val === "string") {
            return {
              description: val,
              box: { top: 0, left: 0, width: 0, height: 0 },
              confidence: 0,
            };
          }
          return val;
        },
        z.object({
          box: z
            .object({
              top: z.number().default(0),
              left: z.number().default(0),
              width: z.number().default(0),
              height: z.number().default(0),
            })
            .default({ top: 0, left: 0, width: 0, height: 0 }),
          description: z.string().optional(),
          confidence: z.number().default(0),
        })
      )
      .optional(),
  })
  .nullable();

export const StateSnapshotSchema = z
  .object({
    subject_type: z.string().default("general"),
    subject: z.string().default("unknown"),
    current_state: z.string().default("active"),
    metrics: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    issue: z
      .object({
        detected: z.boolean().nullable().optional(),
        type: z
          .preprocess(
            (val) => {
              if (val === null || val === undefined) return null;
              if (typeof val !== "string") return "warning";
              const s = val.toLowerCase();
              if (["error", "bug", "blocker", "question", "warning"].includes(s)) return s;
              if (s.includes("fail") || s.includes("err")) return "error";
              return "warning";
            },
            z.enum(["error", "bug", "blocker", "question", "warning"]).nullable()
          )
          .optional(),
        description: z.string().nullable().optional(),
        severity: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable();

export const ActionItemSchema = z.object({
  action: z.string(),
  priority: z
    .preprocess(
      (val) => {
        if (typeof val !== "string") return "medium";
        const s = val.toLowerCase();
        if (["high", "medium", "low"].includes(s)) return s;
        if (s.includes("urgent") || s.includes("critical")) return "high";
        return "medium";
      },
      z.enum(["high", "medium", "low"])
    )
    .optional(),
  source: z.preprocess(
    (val) => {
      if (typeof val !== "string") return "inferred";
      const s = val.toLowerCase();
      if (["explicit", "inferred"].includes(s)) return s;
      return "inferred";
    },
    z.enum(["explicit", "inferred"])
  ),
});

export const VLMContextNodeSchema = z.object({
  screenshot_index: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  app_context: z.object({
    app_hint: z.preprocess((val) => {
      if (typeof val !== "string") return null;
      const s = val.trim();
      if (!s || s.toLowerCase() === "null") return null;
      return s;
    }, z.string().nullable()),
    window_title: z.preprocess((val) => {
      if (typeof val !== "string") return null;
      const s = val.trim();
      return s || null;
    }, z.string().nullable()),
    source_key: z.string(),
    project_name: z.preprocess((val) => {
      if (typeof val !== "string") return null;
      const s = val.trim();
      return s && s.toLowerCase() !== "null" ? s : null;
    }, z.string().nullable().optional()),
    project_key: z.preprocess((val) => {
      if (typeof val !== "string") return null;
      const s = val.trim();
      return s && s.toLowerCase() !== "null" ? s : null;
    }, z.string().nullable().optional()),
  }),
  knowledge: KnowledgeSchema,
  state_snapshot: StateSnapshotSchema,
  entities: z.array(EntityRefSchema).default([]),
  action_items: z.array(ActionItemSchema).nullable().optional(),
  ui_text_snippets: z.array(z.string()).default([]),
  importance: z.number(),
  confidence: z.number(),
  keywords: z.array(z.string()).default([]),
});

export const VLMOutputSchema = z.object({
  nodes: z.array(VLMContextNodeSchema),
});

export const VLMOutputProcessedSchema = VLMOutputSchema.transform((val) => {
  const nodes = val.nodes.map((node) => ({
    screenshotIndex: node.screenshot_index,
    title: node.title,
    summary: node.summary,
    appContext: {
      appHint: (() => {
        const hint = node.app_context.app_hint;
        if (!hint) return null;
        const lowerHint = hint.toLowerCase();
        for (const canonical of CANONICAL_APP_CANDIDATES) {
          if (canonical.toLowerCase() === lowerHint) return canonical;
        }
        return hint;
      })(),
      windowTitle: node.app_context.window_title,
      sourceKey: node.app_context.source_key,
      projectName: node.app_context.project_name ? node.app_context.project_name : null,
      projectKey:
        normalizeProjectKey(node.app_context.project_key) ??
        normalizeProjectKey(node.app_context.project_name) ??
        null,
    },
    knowledge: node.knowledge
      ? {
          contentType: node.knowledge.content_type,
          sourceUrl: node.knowledge.source_url,
          projectOrLibrary: node.knowledge.project_or_library,
          keyInsights: node.knowledge.key_insights,
          language: node.knowledge.language,
          textRegion: node.knowledge.text_region
            ? {
                box: node.knowledge.text_region.box,
                description: node.knowledge.text_region.description,
                confidence: node.knowledge.text_region.confidence,
              }
            : undefined,
        }
      : null,
    stateSnapshot: node.state_snapshot
      ? {
          subjectType: node.state_snapshot.subject_type,
          subject: node.state_snapshot.subject,
          currentState: node.state_snapshot.current_state,
          metrics: node.state_snapshot.metrics,
          issue: node.state_snapshot.issue,
        }
      : null,
    entities: normalizeEntityRefs(node.entities, 10),
    actionItems: node.action_items ? node.action_items.slice(0, 5) : null,
    uiTextSnippets: node.ui_text_snippets.slice(0, 5),
    importance: Math.max(0, Math.min(10, node.importance)),
    confidence: Math.max(0, Math.min(10, node.confidence)),
    keywords: node.keywords.slice(0, 5),
  }));

  return { nodes };
});

export type VLMOutputRaw = z.infer<typeof VLMOutputSchema>;
export type VLMContextNodeRaw = z.infer<typeof VLMContextNodeSchema>;

export type VLMOutput = z.infer<typeof VLMOutputProcessedSchema>;
export type VLMContextNode = VLMOutput["nodes"][number];

export type VLMScreenshotMeta = {
  screenshot_index: number;
  screenshot_id: number;
  captured_at: string;
  source_key: string;
  app_hint: string | null;
  window_title: string | null;
};

// =========================================================================
// Thread LLM Output Schemas
// =========================================================================

const ThreadAssignmentSchema = z.object({
  node_index: z.number().int().nonnegative(),
  thread_id: z.string().min(1),
  reason: z.string(),
});

const ThreadUpdateSchema = z.object({
  thread_id: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  current_phase: z.string().optional(),
  current_focus: z.string().optional(),
  new_milestone: z
    .preprocess(
      (val) => {
        if (typeof val === "string") return { description: val };
        return val;
      },
      z.object({ description: z.string() })
    )
    .optional(),
});

const NewThreadSchema = z.object({
  title: z.string(),
  summary: z.string(),
  current_phase: z.string().optional(),
  node_indices: z.array(z.number().int().nonnegative()),
  milestones: z.array(z.string()),
});

export const ThreadLLMOutputSchema = z.object({
  assignments: z.array(ThreadAssignmentSchema),
  thread_updates: z.array(ThreadUpdateSchema).default([]),
  new_threads: z.array(NewThreadSchema).default([]),
});

export type ThreadLLMOutputRaw = z.infer<typeof ThreadLLMOutputSchema>;

export const ThreadLLMOutputProcessedSchema = ThreadLLMOutputSchema.transform((val) => {
  return {
    assignments: val.assignments.map((a) => ({
      nodeIndex: a.node_index,
      threadId: a.thread_id,
      reason: a.reason,
    })),
    threadUpdates: val.thread_updates.map((u) => ({
      threadId: u.thread_id,
      title: u.title,
      summary: u.summary,
      currentPhase: u.current_phase,
      currentFocus: u.current_focus,
      newMilestone: u.new_milestone ? { description: u.new_milestone.description } : undefined,
    })),
    newThreads: val.new_threads.map((t) => ({
      title: t.title,
      summary: t.summary,
      currentPhase: t.current_phase,
      nodeIndices: t.node_indices,
      milestones: t.milestones,
    })),
  };
});

export type ThreadLLMOutput = z.infer<typeof ThreadLLMOutputProcessedSchema>;

// =========================================================================
// Thread Brief Schemas
// =========================================================================

export const ThreadBriefLLMSchema = z.object({
  brief_markdown: z.string(),
  highlights: z.array(z.string()).default([]),
  current_focus: z.string().default(""),
  next_steps: z.array(z.string()).default([]),
});

export const ThreadBriefLLMProcessedSchema = ThreadBriefLLMSchema.transform((val) => {
  return {
    briefMarkdown: val.brief_markdown,
    highlights: val.highlights,
    currentFocus: val.current_focus,
    nextSteps: val.next_steps,
  };
});

// =========================================================================
// Activity Monitor LLM Output Schemas
// =========================================================================
const ActivityEventKindSchema = z.preprocess(
  (val) => {
    if (typeof val !== "string") return "work";
    const s = val.toLowerCase();
    const allowed = ["focus", "work", "meeting", "break", "browse", "coding", "debugging"];
    if (allowed.includes(s)) return s;
    if (s.includes("code") || s.includes("dev")) return "coding";
    if (s.includes("debug") || s.includes("test")) return "debugging";
    if (s.includes("meet") || s.includes("call")) return "meeting";
    if (s.includes("rest") || s.includes("pause")) return "break";
    if (s.includes("surf") || s.includes("web")) return "browse";
    return "work";
  },
  z.enum(["focus", "work", "meeting", "break", "browse", "coding", "debugging"])
);

const ActivityEventCandidateSchema = z.object({
  title: z.string(),
  kind: ActivityEventKindSchema,
  start_offset_min: z.number(),
  end_offset_min: z.number(),
  confidence: z.number(),
  importance: z.number(),
  description: z.string(),
  node_ids: z.array(z.number().int().positive()),
  thread_id: z.string().nullable().optional(),
});

export const ActivityWindowSummaryLLMSchema = z.object({
  title: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()),
  stats: z.object({
    top_apps: z.array(z.string()),
    top_entities: z.array(z.string()),
  }),
  events: z.array(ActivityEventCandidateSchema),
});

export const ActivityWindowSummaryLLMProcessedSchema = ActivityWindowSummaryLLMSchema.transform(
  (val) => ({
    title: val.title,
    summary: val.summary,
    highlights: val.highlights,
    stats: {
      topApps: val.stats.top_apps,
      topEntities: val.stats.top_entities,
    },
    events: val.events.map((event) => ({
      title: event.title,
      kind: event.kind,
      startOffsetMin: event.start_offset_min,
      endOffsetMin: event.end_offset_min,
      confidence: Math.max(0, Math.min(10, event.confidence)),
      importance: Math.max(0, Math.min(10, event.importance)),
      description: event.description,
      nodeIds: event.node_ids,
      threadId: event.thread_id,
    })),
  })
);

export const ActivityEventDetailsLLMSchema = z.object({
  details: z.string(),
});

export const ActivityEventDetailsLLMProcessedSchema = ActivityEventDetailsLLMSchema;

// =========================================================================
// Deep Search Schemas
// =========================================================================

export const SearchQueryPlanSchema = z.object({
  embedding_text: z.string().min(1),
  filters_patch: z
    .object({
      time_range: z
        .object({
          start: z.number(),
          end: z.number(),
        })
        .nullable()
        .optional(),
      app_hint: z.string().nullable().optional(),
      entities: z.array(z.string()).nullable().optional(),
    })
    .nullable()
    .optional(),
  kind_hint: z.enum(CONTEXT_KIND_VALUES).nullable().optional(),
  extracted_entities: z.array(EntityRefSchema).nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  time_range_reasoning: z.string().nullable().optional(),
  confidence: z.number(),
});

export const SearchQueryPlanProcessedSchema = SearchQueryPlanSchema.transform((val) => {
  const result: {
    embeddingText: string;
    filtersPatch?: {
      timeRange?: { start: number; end: number };
      appHint?: string;
      entities?: string[];
    };
    kindHint?: (typeof CONTEXT_KIND_VALUES)[number];
    extractedEntities?: z.infer<typeof EntityRefSchema>[];
    keywords?: string[];
    timeRangeReasoning?: string;
    confidence: number;
  } = {
    embeddingText: val.embedding_text,
    confidence: Math.max(0, Math.min(1, val.confidence)),
  };

  if (val.filters_patch) {
    result.filtersPatch = {
      timeRange: val.filters_patch.time_range ?? undefined,
      appHint: val.filters_patch.app_hint ?? undefined,
      entities: normalizeEntityNames(val.filters_patch.entities ?? undefined),
    };
    if (
      result.filtersPatch.appHint &&
      !CANONICAL_APP_CANDIDATES.includes(result.filtersPatch.appHint)
    ) {
      delete result.filtersPatch.appHint;
    }
  }

  if (val.kind_hint) {
    result.kindHint = val.kind_hint;
  }

  if (val.extracted_entities) {
    result.extractedEntities = normalizeEntityRefs(val.extracted_entities, 20);
  }

  if (val.keywords) {
    result.keywords = val.keywords.slice(0, 10);
  }

  if (val.time_range_reasoning) {
    result.timeRangeReasoning = val.time_range_reasoning;
  }

  return result;
});

const SearchAnswerCitationSchema = z.object({
  node_id: z.number().int().positive().nullable().optional(),
  screenshot_id: z.number().int().positive().nullable().optional(),
  quote: z.string().nullable().optional(),
});

export const SearchAnswerSchema = z.object({
  answer_title: z.string().nullable().optional(),
  answer: z.string().min(1),
  bullets: z.array(z.string()).nullable().optional(),
  citations: z.array(SearchAnswerCitationSchema).default([]),
  confidence: z.number(),
});

export const SearchAnswerProcessedSchema = SearchAnswerSchema.transform((val) => {
  const result = {
    answerTitle: val.answer_title ?? undefined,
    answer: val.answer,
    bullets: val.bullets ? val.bullets.slice(0, 8) : undefined,
    citations: val.citations.map((citation) => ({
      nodeId: citation.node_id ?? undefined,
      screenshotId: citation.screenshot_id ?? undefined,
      quote: citation.quote ?? undefined,
    })),
    confidence: Math.max(0, Math.min(1, val.confidence)),
  };

  if (result.confidence > 0.2 && result.citations.length === 0) {
    result.confidence = 0.2;
  }

  return result;
});

export type SearchQueryPlanRaw = z.infer<typeof SearchQueryPlanSchema>;
export type SearchAnswerRaw = z.infer<typeof SearchAnswerSchema>;
