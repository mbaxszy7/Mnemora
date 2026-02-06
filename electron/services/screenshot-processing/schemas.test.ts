import { describe, it, expect } from "vitest";

import {
  EntityRefSchema,
  VLMOutputProcessedSchema,
  KnowledgeSchema,
  StateSnapshotSchema,
  ActionItemSchema,
  ThreadLLMOutputProcessedSchema,
  ThreadBriefLLMProcessedSchema,
  ActivityWindowSummaryLLMProcessedSchema,
  ActivityEventDetailsLLMProcessedSchema,
  SearchQueryPlanProcessedSchema,
  SearchAnswerProcessedSchema,
} from "./schemas";

describe("VLMOutputProcessedSchema", () => {
  it("truncates and caps fields", () => {
    const long = "x".repeat(200);
    const input = {
      nodes: [
        {
          screenshot_index: 1,
          title: long,
          summary: "y".repeat(600),
          app_context: {
            app_hint: null,
            window_title: null,
            source_key: "window:1",
            project_name: "Demo Project",
            project_key: "demo-project",
          },
          knowledge: null,
          state_snapshot: null,
          entities: Array.from({ length: 12 }, (_, i) => ({ name: `Entity-${i}`, type: "other" })),
          action_items: Array.from({ length: 7 }, () => ({ action: "todo", source: "explicit" })),
          ui_text_snippets: Array.from({ length: 10 }, () => "snippet"),
          importance: 11,
          confidence: -1,
          keywords: Array.from({ length: 10 }, (_, i) => `k${i}`),
        },
      ],
    };

    const parsed = VLMOutputProcessedSchema.parse(input);
    const node = parsed.nodes[0];

    expect(node.title.length).toBe(200);
    expect(node.summary.length).toBe(600);
    expect(node.entities.length).toBe(10);
    expect(node.actionItems?.length).toBe(5);
    expect(node.uiTextSnippets.length).toBe(5);
    expect(node.importance).toBe(10);
    expect(node.confidence).toBe(0);
    expect(node.keywords.length).toBe(5);
    expect(node.appContext.projectName).toBe("Demo Project");
    expect(node.appContext.projectKey).toBe("demo-project");
  });
});

describe("EntityRefSchema", () => {
  it("accepts shared EntityRef shape", () => {
    const parsed = EntityRefSchema.parse({
      name: "auth-service",
      type: "repo",
      raw: "auth-service",
      confidence: 0.75,
    });

    expect(parsed).toEqual({
      name: "auth-service",
      type: "repo",
      raw: "auth-service",
      confidence: 0.75,
    });
  });

  it("normalizes unknown entity types to 'other'", () => {
    const result = EntityRefSchema.safeParse({
      name: "auth-service",
      type: "invalid",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("other");
    }
  });
});

describe("KnowledgeSchema", () => {
  it("parses null as null", () => {
    expect(KnowledgeSchema.parse(null)).toBeNull();
  });

  it("parses valid knowledge object", () => {
    const parsed = KnowledgeSchema.parse({
      content_type: "tech_doc",
      language: "english",
      key_insights: ["insight1"],
    });
    expect(parsed!.content_type).toBe("tech_doc");
    expect(parsed!.language).toBe("en");
  });

  it("normalizes zh language", () => {
    const parsed = KnowledgeSchema.parse({ content_type: "blog", language: "zh-CN" });
    expect(parsed!.language).toBe("zh");
  });

  it("normalizes non-string language to other", () => {
    const parsed = KnowledgeSchema.parse({ content_type: "blog", language: 123 });
    expect(parsed!.language).toBe("other");
  });

  it("converts string text_region to object", () => {
    const parsed = KnowledgeSchema.parse({
      content_type: "doc",
      text_region: "some region desc",
    });
    expect(parsed!.text_region!.description).toBe("some region desc");
    expect(parsed!.text_region!.box).toEqual({ top: 0, left: 0, width: 0, height: 0 });
  });
});

describe("StateSnapshotSchema", () => {
  it("parses null as null", () => {
    expect(StateSnapshotSchema.parse(null)).toBeNull();
  });

  it("normalizes issue type from string", () => {
    const parsed = StateSnapshotSchema.parse({
      issue: { type: "failure_reason", description: "test" },
    });
    expect(parsed!.issue!.type).toBe("error");
  });

  it("normalizes non-string issue type to warning", () => {
    const parsed = StateSnapshotSchema.parse({
      issue: { type: 123, description: "test" },
    });
    expect(parsed!.issue!.type).toBe("warning");
  });

  it("normalizes null issue type", () => {
    const parsed = StateSnapshotSchema.parse({
      issue: { type: null },
    });
    expect(parsed!.issue!.type).toBeNull();
  });

  it("parses metrics", () => {
    const parsed = StateSnapshotSchema.parse({
      metrics: { cpu: 80, status: "healthy" },
    });
    expect(parsed!.metrics).toEqual({ cpu: 80, status: "healthy" });
  });
});

describe("ActionItemSchema", () => {
  it("normalizes priority from string", () => {
    const parsed = ActionItemSchema.parse({
      action: "fix bug",
      priority: "urgent task",
      source: "explicit",
    });
    expect(parsed.priority).toBe("high");
  });

  it("defaults non-string priority to medium", () => {
    const parsed = ActionItemSchema.parse({ action: "fix bug", priority: 123, source: "explicit" });
    expect(parsed.priority).toBe("medium");
  });

  it("normalizes unknown source to inferred", () => {
    const parsed = ActionItemSchema.parse({ action: "fix bug", source: "auto" });
    expect(parsed.source).toBe("inferred");
  });

  it("normalizes non-string source to inferred", () => {
    const parsed = ActionItemSchema.parse({ action: "fix bug", source: 123 });
    expect(parsed.source).toBe("inferred");
  });
});

describe("VLMOutputProcessedSchema - advanced", () => {
  const baseNode = {
    screenshot_index: 1,
    title: "current_user coding",
    summary: "Working on project",
    app_context: {
      app_hint: null,
      window_title: null,
      source_key: "window:1",
    },
    knowledge: null,
    state_snapshot: null,
    entities: [],
    action_items: null,
    ui_text_snippets: [],
    importance: 5,
    confidence: 8,
    keywords: [],
  };

  it("normalizes app_hint to canonical name", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [{ ...baseNode, app_context: { ...baseNode.app_context, app_hint: "google chrome" } }],
    });
    expect(parsed.nodes[0].appContext.appHint).toBe("Google Chrome");
  });

  it("passes through non-canonical app_hint as-is", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        { ...baseNode, app_context: { ...baseNode.app_context, app_hint: "SomeUnknownApp" } },
      ],
    });
    expect(parsed.nodes[0].appContext.appHint).toBe("SomeUnknownApp");
  });

  it("normalizes project_key", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: {
            ...baseNode.app_context,
            project_name: "My Project",
            project_key: "My Project",
          },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.projectKey).toBe("my-project");
  });

  it("falls back project_key from project_name", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, project_name: "Auth Service", project_key: null },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.projectKey).toBe("auth-service");
  });

  it("handles knowledge with text_region", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          knowledge: {
            content_type: "tech_doc",
            language: "en",
            text_region: {
              box: { top: 10, left: 20, width: 100, height: 50 },
              description: "header",
              confidence: 0.9,
            },
          },
        },
      ],
    });
    expect(parsed.nodes[0].knowledge!.textRegion!.box.top).toBe(10);
  });

  it("handles state_snapshot with issue", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          state_snapshot: {
            subject_type: "error",
            subject: "TS compilation",
            current_state: "failed",
            issue: { detected: true, type: "error", description: "TS2339", severity: 3 },
          },
        },
      ],
    });
    expect(parsed.nodes[0].stateSnapshot!.issue!.type).toBe("error");
  });

  it("filters empty entity names", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          entities: [
            { name: "valid", type: "project" },
            { name: "  ", type: "other" },
            { name: "", type: "other" },
          ],
        },
      ],
    });
    expect(parsed.nodes[0].entities).toHaveLength(1);
    expect(parsed.nodes[0].entities[0].name).toBe("valid");
  });

  it("clamps entity confidence to [0,1]", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          entities: [{ name: "e", type: "other", confidence: 5 }],
        },
      ],
    });
    expect(parsed.nodes[0].entities[0].confidence).toBe(1);
  });
});

describe("ThreadLLMOutputProcessedSchema", () => {
  it("transforms thread assignment output", () => {
    const parsed = ThreadLLMOutputProcessedSchema.parse({
      assignments: [{ node_index: 0, thread_id: "abc", reason: "continues work" }],
      thread_updates: [
        {
          thread_id: "abc",
          title: "Updated",
          current_phase: "debugging",
          new_milestone: "Fixed the bug",
        },
      ],
      new_threads: [
        {
          title: "New thread",
          summary: "Research",
          current_phase: "research",
          node_indices: [1],
          milestones: ["Started research"],
        },
      ],
    });
    expect(parsed.assignments[0].nodeIndex).toBe(0);
    expect(parsed.threadUpdates[0].newMilestone!.description).toBe("Fixed the bug");
    expect(parsed.newThreads[0].title).toBe("New thread");
  });

  it("uses defaults for optional fields", () => {
    const parsed = ThreadLLMOutputProcessedSchema.parse({
      assignments: [{ node_index: 0, thread_id: "NEW", reason: "new" }],
    });
    expect(parsed.threadUpdates).toEqual([]);
    expect(parsed.newThreads).toEqual([]);
  });

  it("handles milestone as object", () => {
    const parsed = ThreadLLMOutputProcessedSchema.parse({
      assignments: [],
      thread_updates: [
        {
          thread_id: "abc",
          new_milestone: { description: "milestone desc" },
        },
      ],
    });
    expect(parsed.threadUpdates[0].newMilestone!.description).toBe("milestone desc");
  });
});

describe("ThreadBriefLLMProcessedSchema", () => {
  it("transforms thread brief output", () => {
    const parsed = ThreadBriefLLMProcessedSchema.parse({
      brief_markdown: "# Brief",
      highlights: ["h1"],
      current_focus: "auth",
      next_steps: ["step1"],
    });
    expect(parsed.briefMarkdown).toBe("# Brief");
    expect(parsed.currentFocus).toBe("auth");
  });
});

describe("ActivityWindowSummaryLLMProcessedSchema", () => {
  it("transforms activity summary", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse({
      title: "Working on auth",
      summary: "## Core Tasks\n- auth",
      highlights: ["Fixed bug"],
      stats: { top_apps: ["VS Code"], top_entities: ["auth"] },
      events: [
        {
          title: "Debug auth",
          kind: "debugging",
          start_offset_min: 0,
          end_offset_min: 15,
          confidence: 8,
          importance: 7,
          description: "Debugging auth",
          node_ids: [1, 2],
        },
      ],
    });
    expect(parsed.stats.topApps).toEqual(["VS Code"]);
    expect(parsed.events[0].startOffsetMin).toBe(0);
    expect(parsed.events[0].confidence).toBe(8);
  });

  it("normalizes activity event kind", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse({
      title: "t",
      summary: "s",
      highlights: [],
      stats: { top_apps: [], top_entities: [] },
      events: [
        {
          title: "t",
          kind: "development",
          start_offset_min: 0,
          end_offset_min: 5,
          confidence: 5,
          importance: 5,
          description: "d",
          node_ids: [1],
        },
      ],
    });
    expect(parsed.events[0].kind).toBe("coding");
  });

  it("clamps confidence/importance to [0,10]", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse({
      title: "t",
      summary: "s",
      highlights: [],
      stats: { top_apps: [], top_entities: [] },
      events: [
        {
          title: "t",
          kind: "work",
          start_offset_min: 0,
          end_offset_min: 5,
          confidence: 15,
          importance: -5,
          description: "d",
          node_ids: [1],
        },
      ],
    });
    expect(parsed.events[0].confidence).toBe(10);
    expect(parsed.events[0].importance).toBe(0);
  });
});

describe("ActivityEventDetailsLLMProcessedSchema", () => {
  it("parses event details", () => {
    const parsed = ActivityEventDetailsLLMProcessedSchema.parse({ details: "# Report" });
    expect(parsed.details).toBe("# Report");
  });
});

describe("SearchQueryPlanProcessedSchema", () => {
  it("transforms search query plan", () => {
    const parsed = SearchQueryPlanProcessedSchema.parse({
      embedding_text: "auth debugging",
      filters_patch: {
        time_range: { start: 1000, end: 2000 },
        app_hint: "Google Chrome",
        entities: ["auth-service"],
      },
      kind_hint: "event",
      extracted_entities: [{ name: "auth", type: "project" }],
      keywords: ["auth", "debug"],
      time_range_reasoning: "yesterday",
      confidence: 0.9,
    });
    expect(parsed.embeddingText).toBe("auth debugging");
    expect(parsed.filtersPatch!.timeRange!.start).toBe(1000);
    expect(parsed.kindHint).toBe("event");
    expect(parsed.keywords).toEqual(["auth", "debug"]);
    expect(parsed.timeRangeReasoning).toBe("yesterday");
  });

  it("removes non-canonical app_hint", () => {
    const parsed = SearchQueryPlanProcessedSchema.parse({
      embedding_text: "test",
      filters_patch: { app_hint: "NotARealApp" },
      confidence: 0.5,
    });
    expect(parsed.filtersPatch!.appHint).toBeUndefined();
  });

  it("clamps confidence to [0,1]", () => {
    const parsed = SearchQueryPlanProcessedSchema.parse({
      embedding_text: "test",
      confidence: 5,
    });
    expect(parsed.confidence).toBe(1);
  });

  it("handles empty entities", () => {
    const parsed = SearchQueryPlanProcessedSchema.parse({
      embedding_text: "test",
      filters_patch: { entities: ["  ", ""] },
      confidence: 0.5,
    });
    expect(parsed.filtersPatch!.entities).toBeUndefined();
  });
});

describe("normalizeProjectKey edge cases via VLMOutputProcessedSchema", () => {
  const baseNode = {
    screenshot_index: 1,
    title: "t",
    summary: "s",
    app_context: {
      app_hint: null,
      window_title: null,
      source_key: "window:1",
    },
    knowledge: null,
    state_snapshot: null,
    entities: [],
    action_items: null,
    ui_text_snippets: [],
    importance: 5,
    confidence: 5,
    keywords: [],
  };

  it("normalizes project_key 'null' string to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, project_key: "null" },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.projectKey).toBeNull();
  });

  it("normalizes project_name 'null' string to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, project_name: "NULL" },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.projectName).toBeNull();
  });

  it("normalizes empty project_key to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, project_key: "   " },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.projectKey).toBeNull();
  });

  it("normalizes project_key with only special chars to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, project_key: "!!@@##" },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.projectKey).toBeNull();
  });

  it("normalizes window_title empty string to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, window_title: "  " },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.windowTitle).toBeNull();
  });

  it("normalizes non-string window_title to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, window_title: 123 },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.windowTitle).toBeNull();
  });

  it("normalizes app_hint empty string to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, app_hint: "  " },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.appHint).toBeNull();
  });

  it("normalizes app_hint 'null' string to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, app_hint: "null" },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.appHint).toBeNull();
  });

  it("normalizes non-string app_hint to null", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          app_context: { ...baseNode.app_context, app_hint: 42 },
        },
      ],
    });
    expect(parsed.nodes[0].appContext.appHint).toBeNull();
  });

  it("handles knowledge without text_region (undefined)", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          knowledge: {
            content_type: "tech_doc",
            language: "en",
          },
        },
      ],
    });
    expect(parsed.nodes[0].knowledge!.textRegion).toBeUndefined();
  });

  it("handles entity with raw field", () => {
    const parsed = VLMOutputProcessedSchema.parse({
      nodes: [
        {
          ...baseNode,
          entities: [{ name: "auth", type: "project", raw: " raw-text " }],
        },
      ],
    });
    expect(parsed.nodes[0].entities[0].raw).toBe("raw-text");
  });
});

describe("KnowledgeSchema language branch coverage", () => {
  it("normalizes 'cn' to zh", () => {
    const parsed = KnowledgeSchema.parse({ content_type: "doc", language: "cn" });
    expect(parsed!.language).toBe("zh");
  });

  it("normalizes '中文' to zh", () => {
    const parsed = KnowledgeSchema.parse({ content_type: "doc", language: "中文文档" });
    expect(parsed!.language).toBe("zh");
  });
});

describe("StateSnapshotSchema issue type branch coverage", () => {
  it("normalizes 'err' substring to error", () => {
    const parsed = StateSnapshotSchema.parse({
      issue: { type: "error_occurred" },
    });
    expect(parsed!.issue!.type).toBe("error");
  });

  it("normalizes exact 'bug' type", () => {
    const parsed = StateSnapshotSchema.parse({
      issue: { type: "bug" },
    });
    expect(parsed!.issue!.type).toBe("bug");
  });

  it("normalizes exact 'blocker' type", () => {
    const parsed = StateSnapshotSchema.parse({
      issue: { type: "blocker" },
    });
    expect(parsed!.issue!.type).toBe("blocker");
  });

  it("normalizes exact 'question' type", () => {
    const parsed = StateSnapshotSchema.parse({
      issue: { type: "question" },
    });
    expect(parsed!.issue!.type).toBe("question");
  });
});

describe("ActionItemSchema priority branch coverage", () => {
  it("normalizes 'critical' to high", () => {
    const parsed = ActionItemSchema.parse({
      action: "fix",
      priority: "critical issue",
      source: "explicit",
    });
    expect(parsed.priority).toBe("high");
  });

  it("normalizes exact 'high' priority", () => {
    const parsed = ActionItemSchema.parse({ action: "fix", priority: "high", source: "explicit" });
    expect(parsed.priority).toBe("high");
  });

  it("normalizes exact 'low' priority", () => {
    const parsed = ActionItemSchema.parse({ action: "fix", priority: "low", source: "explicit" });
    expect(parsed.priority).toBe("low");
  });

  it("normalizes unknown string to medium", () => {
    const parsed = ActionItemSchema.parse({
      action: "fix",
      priority: "whenever",
      source: "explicit",
    });
    expect(parsed.priority).toBe("medium");
  });
});

describe("ActivityEventKindSchema branch coverage", () => {
  const makeEvent = (kind: unknown) => ({
    title: "t",
    summary: "s",
    highlights: [],
    stats: { top_apps: [], top_entities: [] },
    events: [
      {
        title: "t",
        kind,
        start_offset_min: 0,
        end_offset_min: 5,
        confidence: 5,
        importance: 5,
        description: "d",
        node_ids: [1],
      },
    ],
  });

  it("normalizes non-string to work", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent(123));
    expect(parsed.events[0].kind).toBe("work");
  });

  it("normalizes exact 'focus' kind", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("focus"));
    expect(parsed.events[0].kind).toBe("focus");
  });

  it("normalizes 'debug_session' to debugging", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("debug_session"));
    expect(parsed.events[0].kind).toBe("debugging");
  });

  it("normalizes 'testing' to debugging", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("testing"));
    expect(parsed.events[0].kind).toBe("debugging");
  });

  it("normalizes 'meeting_call' to meeting", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("meeting_call"));
    expect(parsed.events[0].kind).toBe("meeting");
  });

  it("normalizes 'phone_call' to meeting", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("phone_call"));
    expect(parsed.events[0].kind).toBe("meeting");
  });

  it("normalizes 'rest_period' to break", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("rest_period"));
    expect(parsed.events[0].kind).toBe("break");
  });

  it("normalizes 'pause_time' to break", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("pause_time"));
    expect(parsed.events[0].kind).toBe("break");
  });

  it("normalizes 'surfing_web' to browse", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("surfing_web"));
    expect(parsed.events[0].kind).toBe("browse");
  });

  it("normalizes 'web_research' to browse", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("web_research"));
    expect(parsed.events[0].kind).toBe("browse");
  });

  it("normalizes unknown kind to work", () => {
    const parsed = ActivityWindowSummaryLLMProcessedSchema.parse(makeEvent("something_random"));
    expect(parsed.events[0].kind).toBe("work");
  });
});

describe("ThreadLLMOutputProcessedSchema branch coverage", () => {
  it("handles thread_updates without new_milestone", () => {
    const parsed = ThreadLLMOutputProcessedSchema.parse({
      assignments: [],
      thread_updates: [
        {
          thread_id: "abc",
          title: "Update",
          summary: "Summary",
          current_phase: "coding",
        },
      ],
    });
    expect(parsed.threadUpdates[0].newMilestone).toBeUndefined();
  });
});

describe("SearchAnswerProcessedSchema branch coverage", () => {
  it("handles citations with all null optional fields", () => {
    const parsed = SearchAnswerProcessedSchema.parse({
      answer: "answer",
      citations: [{ node_id: null, screenshot_id: null, quote: null }],
      confidence: 0.8,
    });
    expect(parsed.citations[0].nodeId).toBeUndefined();
    expect(parsed.citations[0].screenshotId).toBeUndefined();
    expect(parsed.citations[0].quote).toBeUndefined();
  });

  it("does not cap confidence when citations exist", () => {
    const parsed = SearchAnswerProcessedSchema.parse({
      answer: "answer",
      citations: [{ node_id: 1 }],
      confidence: 0.8,
    });
    expect(parsed.confidence).toBe(0.8);
  });

  it("handles null bullets", () => {
    const parsed = SearchAnswerProcessedSchema.parse({
      answer: "answer",
      citations: [],
      confidence: 0.1,
    });
    expect(parsed.bullets).toBeUndefined();
  });
});

describe("SearchAnswerProcessedSchema", () => {
  it("transforms search answer", () => {
    const parsed = SearchAnswerProcessedSchema.parse({
      answer_title: "Results",
      answer: "Found 3 matches",
      bullets: ["b1", "b2"],
      citations: [{ node_id: 1, screenshot_id: 2, quote: "evidence" }],
      confidence: 0.8,
    });
    expect(parsed.answerTitle).toBe("Results");
    expect(parsed.citations[0].nodeId).toBe(1);
  });

  it("caps confidence at 0.2 when no citations", () => {
    const parsed = SearchAnswerProcessedSchema.parse({
      answer: "No results",
      citations: [],
      confidence: 0.9,
    });
    expect(parsed.confidence).toBe(0.2);
  });

  it("limits bullets to 8", () => {
    const parsed = SearchAnswerProcessedSchema.parse({
      answer: "answer",
      bullets: Array.from({ length: 12 }, (_, i) => `b${i}`),
      citations: [{ node_id: 1 }],
      confidence: 0.8,
    });
    expect(parsed.bullets!.length).toBe(8);
  });
});
