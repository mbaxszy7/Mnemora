import { z } from "zod";

// =========================================================================
// VLM Output Schemas (Alpha - One Node per Screenshot)
// =========================================================================

function truncateTo(maxLen: number) {
  return (s: string) => (s.length > maxLen ? s.slice(0, maxLen) : s);
}

export const EntityTypeSchema = z.enum([
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
]);

export const EntityRefSchema = z.object({
  name: z.string(),
  type: EntityTypeSchema,
  raw: z.string().optional(),
  confidence: z.number().optional(),
});

export const KnowledgeSchema = z
  .object({
    content_type: z.string(),
    source_url: z.string().optional(),
    project_or_library: z.string().optional(),
    key_insights: z.array(z.string()).default([]),
    language: z.enum(["en", "zh", "other"]),
    text_region: z
      .object({
        box: z.object({
          top: z.number(),
          left: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        description: z.string().optional(),
        confidence: z.number(),
      })
      .optional(),
  })
  .nullable();

export const StateSnapshotSchema = z
  .object({
    subject_type: z.string(),
    subject: z.string(),
    current_state: z.string(),
    metrics: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    issue: z
      .object({
        detected: z.boolean(),
        type: z.enum(["error", "bug", "blocker", "question", "warning"]),
        description: z.string(),
        severity: z.number(),
      })
      .optional(),
  })
  .nullable();

export const ActionItemSchema = z.object({
  action: z.string(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  source: z.enum(["explicit", "inferred"]),
});

export const VLMContextNodeSchema = z.object({
  screenshot_index: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  app_context: z.object({
    app_hint: z.string().nullable(),
    window_title: z.string().nullable(),
    source_key: z.string(),
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
    title: truncateTo(100)(node.title),
    summary: truncateTo(500)(node.summary),
    appContext: {
      appHint: node.app_context.app_hint,
      windowTitle: node.app_context.window_title,
      sourceKey: node.app_context.source_key,
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
    entities: node.entities.slice(0, 10).map((entity) => ({
      ...entity,
      name: truncateTo(120)(entity.name),
    })),
    actionItems: node.action_items ? node.action_items.slice(0, 5) : null,
    uiTextSnippets: node.ui_text_snippets.slice(0, 5).map(truncateTo(200)),
    importance: Math.max(0, Math.min(10, node.importance)),
    confidence: Math.max(0, Math.min(10, node.confidence)),
    keywords: node.keywords.slice(0, 5).map(truncateTo(64)),
  }));

  return { nodes };
});

export type VLMOutputRaw = z.infer<typeof VLMOutputSchema>;
export type VLMContextNodeRaw = z.infer<typeof VLMContextNodeSchema>;

export type VLMOutput = z.infer<typeof VLMOutputProcessedSchema>;
export type VLMContextNode = VLMOutput["nodes"][number];
export type EntityRef = z.infer<typeof EntityRefSchema>;

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
  reason: z.string().max(100),
});

const ThreadUpdateSchema = z.object({
  thread_id: z.string().min(1),
  title: z.string().max(100).optional(),
  summary: z.string().max(300).optional(),
  current_phase: z.string().optional(),
  current_focus: z.string().optional(),
  new_milestone: z
    .object({
      description: z.string(),
    })
    .optional(),
});

const NewThreadSchema = z.object({
  title: z.string().max(100),
  summary: z.string().max(300),
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
