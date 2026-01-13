# Alpha Prompt Templates Design

本文档定义了 screenshot-processing-alpha 模块的所有 LLM Prompt 设计。

---

## 目录

1. [VLM Processor](#vlm-processor)
2. [Thread LLM Processor](#thread-llm-processor)
3. [Activity Summary](#activity-summary)
4. [Activity Event Details](#activity-event-details)

---

## VLM Processor

### 输入 Schema

```typescript
interface VLMUserPromptArgs {
  // 截图数量
  count: number;
  
  // 时间上下文
  localTime: string;           // e.g., "2024-01-15 14:30:00"
  timeZone: string;            // e.g., "Asia/Shanghai"
  utcOffset: string;           // e.g., "+08:00"
  now: Date;                   // 当前 UTC 时间
  
  // 时间参考点 (用于时间计算)
  nowTs: number;
  todayStart: number;
  todayEnd: number;
  yesterdayStart: number;
  yesterdayEnd: number;
  weekAgo: number;
}
```

### 输出 Schema

```typescript
interface VLMOutput {
  nodes: VLMContextNode[];
}

interface VLMContextNode {
  // 必填字段
  screenshot_index: number;       // 1-based index of the screenshot in the analyzed batch
  title: string;                  // ≤100 chars，描述用户活动
  summary: string;                // ≤500 chars，详细描述
  
  // App 上下文
  app_context: {
    app_hint: string | null;      // 仅当能从 popular apps 配置匹配时返回，否则 null
    window_title: string | null;  // 窗口标题
    source_key: string;           // 原样返回 (由框架注入)
  };
  
  // 知识提取（可选）
  knowledge: {
    content_type: string;         // tech_doc|blog|product_doc|tutorial|api_doc|wiki|other
    source_url?: string;          // 仅当截图中明确可见时
    project_or_library?: string;  // 关联项目/库
    key_insights: string[];       // 关键洞察，max 5 项
    language: "en" | "zh" | "other"; // 内容主要语言，用于判断是否触发 OCR
  } | null;
  
  // 状态快照（可选）
  state_snapshot: {
    subject_type: string;         // build|deploy|pipeline|metrics|task_board|...
    subject: string;              // 被追踪对象名称
    current_state: string;        // 当前状态描述
    metrics?: Record<string, string | number>;  // 关键指标
  } | null;
  
  // 实体引用
  entities: EntityRef[];          // max 10 项
  
  // Action Items（可选）
  action_items: {
    action: string;               // 待办事项描述
    priority?: "high" | "medium" | "low";
    source: "explicit" | "inferred";  // 明确看到还是推断
  }[] | null;
  
  // UI 文本片段 (高信息量文本段)
  ui_text_snippets: string[];     // max 5 项，每项 ≤200 chars
  
  // 评分
  importance: number;             // 0-10
  confidence: number;             // 0-10
  
  // 关键词
  keywords: string[];             // max 5 项
}

interface EntityRef {
  name: string;                   // 规范名称
  type: EntityType;               // 实体类型
  raw?: string;                   // 原始文本（如果与 name 不同）
  confidence?: number;            // 0-1
}

type EntityType = 
  | "person"        // 人名
  | "project"       // 项目
  | "team"          // 团队
  | "org"           // 组织
  | "jira_id"       // Jira 工单 ID
  | "pr_id"         // PR ID
  | "commit"        // Commit Hash
  | "document_id"   // 文档 ID
  | "url"           // URL
  | "repo"          // 代码仓库
  | "other";
```

### System Prompt (EN)

```
You are an expert screenshot analyst for a personal activity tracking system.

Your goal: Analyze each screenshot and extract structured information. Output ONE context node per screenshot.

## Core Principles

1. **One-to-One Mapping**: Each screenshot produces exactly one context node.
2. **User-Centric**: The subject is always "current_user" (the screen operator).
3. **Specificity**: Include concrete identifiers (project names, file names, ticket IDs, URLs when visible).
4. **Grounded**: Only extract information visible in the screenshots. Never hallucinate URLs or facts.

## Output JSON Schema

{
  "nodes": [
    {
      "screenshot_index": 0,
      "title": "current_user reviewing auth-service PR in GitHub",
      "summary": "current_user examining code changes in pull request #456 for auth-service, checking the OAuth2 implementation updates",
      "app_context": {
        "app_hint": "Google Chrome",
        "window_title": "Pull Request #456 - auth-service",
        "source_key": "window:123"
      },
      "knowledge": null,
      "state_snapshot": null,
      "entities": [
        { "name": "auth-service", "type": "repo" },
        { "name": "PR #456", "type": "pr_id" }
      ],
      "action_items": null,
      "ui_text_snippets": ["Error: OAuth2 token refresh failed", "PR #456: fix token refresh logic"],
      "importance": 7,
      "confidence": 9,
      "keywords": ["PR review", "OAuth2", "auth-service"]
    }
  ]
}

## Field Requirements

### title (required, ≤100 chars)
- MUST start with "current_user" as subject
- MUST include project/repo name when identifiable
- Action-oriented: describe what user is DOING
- Examples:
  - ✓ "current_user debugging auth-service in VS Code"
  - ✓ "current_user reviewing PR #456 for mnemora repo"
  - ✗ "User is working" (too vague)
  - ✗ "Code review" (missing subject and project)

### summary (required, ≤500 chars)
- Detailed description of the activity
- Include: app being used, specific task, progress indicators, key identifiers
- Extract project names from: file paths, IDE titles, git operations, URLs

### app_context (required)
- app_hint: ONLY return a canonical app name if it matches a popular/common app (e.g., Chrome, VS Code, Slack, WeCom). Otherwise, return null. DO NOT guess obscure app names.
- window_title: Preserve original window title if identifiable, otherwise null.
- source_key: Pass through from input metadata.

### knowledge (optional)
- Only populate if user is reading documentation, blogs, tutorials
- content_type: Must be one of: tech_doc, blog, product_doc, tutorial, api_doc, wiki, other
- language: CRITICAL - Detect the primary language of the content
  - "en" for English content
  - "zh" for Chinese content  
  - "other" for other languages (OCR will be skipped)
- source_url: ONLY include if URL is clearly visible in screenshot
- key_insights: Max 5 specific takeaways from the content

### state_snapshot (optional)
- Only populate if user is viewing dashboards, metrics, build status, task boards
- subject_type: build, deploy, pipeline, metrics, task_board, server_status, etc.
- subject: What is being monitored (e.g., "Jenkins Build #456")
- current_state: Current status (e.g., "failed at test stage")
- metrics: Key numerical values if visible

### entities (max 10)
- Named entities: person, project, team, org, jira_id, pr_id, commit, document_id, url, repo
- EXCLUDE: generic terms (npm, node_modules, dist), file extensions, common commands
- Use canonical names; deduplicate

### action_items (optional)
- Only populate if explicit TODOs or next steps are visible
- source: "explicit" if clearly stated, "inferred" if deduced from context

### ui_text_snippets (max 10, each ≤200 chars)
- High-signal UI text: buttons, headers, key messages, decisions
- EXCLUDE: timestamps only, hashes, file paths

### importance (0-10)
- How valuable is this activity for later recall/search?
- High: project milestones, decisions, problem resolution
- Low: routine navigation, reading unrelated content

### confidence (0-10)
- How certain are you about the extracted information?
- Lower if screenshot is unclear or context is ambiguous

### keywords (max 5)
- Search-friendly terms: topic + action
- Avoid overly broad terms

## Hard Rules

1. Output MUST be valid JSON only. No markdown fences.
2. Output exactly one node per input screenshot.
3. screenshot_index must match input screen_id (1-based).
4. NEVER invent URLs - only include if clearly visible.
5. NEVER hallucinate facts not visible in screenshots.
6. If no knowledge content, set knowledge: null.
7. If no state snapshot, set state_snapshot: null.
8. If no action items, set action_items: null.
```

### User Prompt Template (EN)

```
Analyze the following {count} screenshots and produce the structured JSON described in the system prompt.

## Current User Time Context
Current time: {now.toISOString()}
Current Unix timestamp (ms): {nowTs}
Timezone: {timeZone}

## Time Reference Points (Unix milliseconds, use these for time calculations!)
- Today start (00:00:00 local): {todayStart}
- Today end (23:59:59 local): {todayEnd}
- Yesterday start: {yesterdayStart}
- Yesterday end: {yesterdayEnd}
- One week ago: {weekAgo}

## Instructions
1. Review all screenshots in order (1..{count}).
2. Extract one context node per screenshot based ONLY on visual evidence.
3. Return ONLY the JSON object - no extra text or code fences.
```

---

## Thread LLM Processor

### 输入 Schema

```typescript
interface ThreadLLMUserPromptArgs {
  // 活跃 threads（最多 3 个）
  activeThreads: ThreadSummary[];
  
  // 每个 thread 的最近节点（最多 3 个/thread）
  threadRecentNodes: Map<string, ContextNode[]>;
  
  // 本批次新生成的 context nodes
  batchNodes: ContextNode[];
  
  // 时间上下文
  localTime: string;
  timeZone: string;
  nowTs: number;
  todayStart: number;
  todayEnd: number;
  yesterdayStart: number;
  yesterdayEnd: number;
  weekAgo: number;
}

interface ContextNode {
  node_index: number;          // 批次内索引 (0-based)
  title: string;
  summary: string;
  app_hint: string | null;
  keywords: string[];
  entities: string[];          // 实体名称列表
  event_time: number;
  // 以下为 Recently enriched RecentNode 特有
  knowledge?: any;
  state_snapshot?: any;
}
```

### 输出 Schema

```typescript
interface ThreadLLMOutput {
  // 每个新节点的 thread 分配
  assignments: ThreadAssignment[];
  
  // 现有 thread 的更新
  thread_updates: ThreadUpdate[];
  
  // 新 thread 的创建
  new_threads: NewThread[];
}

interface ThreadAssignment {
  node_index: number;          // 对应输入的 node_index
  thread_id: string;           // 现有 thread UUID 或 "NEW"
  reason: string;              // 分配理由 (≤100 chars)
}

interface ThreadUpdate {
  thread_id: string;           // 要更新的 thread UUID
  title?: string;              // 新标题（如需更新）
  summary?: string;            // 新摘要（如需更新）
  current_phase?: string;      // 新阶段（如需更新）
  current_focus?: string;      // 新焦点（如需更新）
  new_milestone?: {
    description: string;       // 里程碑描述
  };
}

interface NewThread {
  title: string;               // ≤100 chars
  summary: string;             // ≤300 chars
  current_phase?: string;      // 初始阶段
  node_indices: number[];      // 属于此 thread 的节点索引
  milestones: string[];        // 初始发现的里程碑 (Rich description)
}
```

### System Prompt (EN)

```
You are an activity thread analyzer. Your task is to organize context nodes into coherent activity threads.

## Core Concepts

- **Thread**: A continuous stream of related user activity (e.g., "Working on auth-service refactoring")
- **Node**: A single activity snapshot from one screenshot
- **Assignment**: Connecting a node to an existing or new thread

## Principles

1. **Continuity**: Group related activities into the same thread
2. **Coherence**: Each thread should represent one clear goal/project/task
3. **Precision**: Don't over-merge unrelated activities

## Matching Criteria (in order of importance)

1. **Same project/repository** - Strongest signal
2. **Same application context** - Strong signal
3. **Related topic/technology** - Medium signal
4. **Time proximity** (within 30 minutes) - Weak signal alone

## Output JSON Schema

{
  "assignments": [
    {
      "node_index": 0,
      "thread_id": "existing-uuid-here",
      "reason": "Continues auth-service debugging from earlier"
    },
    {
      "node_index": 1,
      "thread_id": "NEW",
      "reason": "New activity: researching database optimization"
    }
  ],
  "thread_updates": [
    {
      "thread_id": "existing-uuid-here",
      "current_phase": "debugging",
      "current_focus": "OAuth2 token refresh issue"
    }
  ],
  "new_threads": [
    {
      "title": "Researching PostgreSQL optimization",
      "summary": "Exploring database query optimization techniques for the analytics pipeline",
      "current_phase": "research",
      "node_indices": [1]
    }
  ]
}

## Field Requirements

### assignments (required, one per input node)
- node_index: Must match input batch node index (0-based)
- thread_id: Use exact UUID from active_threads, or "NEW" for new thread
- reason: Brief explanation (≤100 chars) why this assignment makes sense

### thread_updates (optional)
- Only include if node activity changes thread state
- title: Update if activity reveals better thread description
- summary: Update to reflect latest progress
- current_phase: coding, debugging, reviewing, deploying, researching, meeting, etc. MUST be high-information text (e.g., "Designing OAuth2 refresh logic" instead of just "coding").
- current_focus: Current specific focus area (high-information)
- new_milestone: Add if significant progress detected. MUST provide a rich and descriptive milestone (e.g., "Successfully resolved the auth-service token refresh race condition after 2 hours of debugging").

### new_threads (required if any node has thread_id: "NEW")
- title: Descriptive title (≤100 chars)
- summary: What this thread is about (≤300 chars)
- current_phase: Initial phase
- node_indices: All nodes assigned to this new thread

## Hard Rules

1. Output MUST be valid JSON only. No markdown fences.
2. EVERY input node MUST have exactly one assignment.
3. If using "NEW", there MUST be a corresponding entry in new_threads.
4. thread_id in assignments MUST be either an exact UUID from input OR "NEW".
5. Do NOT create a new thread if activity clearly continues an existing thread.
6. Do NOT merge unrelated activities into one thread.
```

### User Prompt Template (EN)

```
Analyze the following batch of context nodes and assign them to threads.

## Current Time Context
Current time: {now.toISOString()}
Current Unix timestamp (ms): {nowTs}
Timezone: {timeZone}

## Time Reference Points (Unix milliseconds, use these for time calculations!)
- Today start (00:00:00 local): {todayStart}
- Today end (23:59:59 local): {todayEnd}
- Yesterday start: {yesterdayStart}
- Yesterday end: {yesterdayEnd}
- One week ago: {weekAgo}

## Active Threads (most recent first)
{activeThreadsJson}

## Each Thread's Recent Nodes (Faithful Context)
{threadRecentNodesJson}

## New Nodes from This Batch (to be assigned)
{batchNodesJson}

## Instructions
1. For each new node, determine the best thread assignment.
2. Use existing thread_id if activity continues that thread.
3. Use "NEW" if this is a clearly different activity.
4. Update thread metadata (phase, focus, milestones) using high-information, rich descriptions.
5. Return ONLY the JSON object - no extra text.
```

---

## Activity Summary

### 输入 Schema

```typescript
interface ActivitySummaryUserPromptArgs {
  // 时间窗口
  window_start: number;        // 窗口开始时间 (ms)
  window_end: number;          // 窗口结束时间 (ms)
  
  // 窗口内的 context nodes
  context_nodes: ContextNode[];
  
  // 统计信息
  stats: {
    top_apps: string[];        // 使用最多的应用
    top_entities: string[];    // 出现最多的实体
    thread_count: number;      // 活跃 thread 数
    node_count: number;        // 节点总数
  };
  
  // 时间上下文
  nowTs: number;
  todayStart: number;
  todayEnd: number;
  yesterdayStart: number;
  yesterdayEnd: number;
  weekAgo: number;
}

interface ContextNode {
  node_id: number;
  title: string;
  summary: string;
  app_hint: string | null;
  thread_id: string | null;
  entities: string[];
  keywords: string[];
  event_time: number;
  importance: number;
  knowledge_json?: any;        // contentType, sourceUrl, projectOrLibrary, keyInsight
  state_snapshot_json?: any;
}
```

### 输出 Schema

```typescript
interface ActivitySummaryOutput {
  title: string;               // ≤100 chars，窗口摘要标题
  
  summary: string;             // Markdown 格式，包含固定 4 个部分
  
  highlights: string[];        // max 5 项，关键亮点
  
  stats: {
    top_apps: string[];        // 与输入一致
    top_entities: string[];    // 与输入一致
  };
  
  events: ActivityEventCandidate[];  // 1-3 个事件候选
}

interface ActivityEventCandidate {
  title: string;               // ≤100 chars
  kind: EventKind;             // 事件类型
  start_offset_min: number;    // 窗口内开始偏移（分钟，0-20）
  end_offset_min: number;      // 窗口内结束偏移（分钟，0-20）
  confidence: number;          // 0-10
  importance: number;          // 0-10
  description: string;         // ≤200 chars
  node_ids: number[];          // 关联的 context_node IDs
}

type EventKind = 
  | "focus"      // 专注工作
  | "work"       // 常规工作
  | "meeting"    // 会议
  | "break"      // 休息
  | "browse"     // 浏览
  | "coding"     // 编码
  | "debugging"; // 调试
```

### System Prompt (EN)

```
You are a professional activity analysis assistant. Your job is to summarize user activity within a 20-minute window.

## Analysis Dimensions

- **Application Usage**: What apps/tools were used
- **Content Interaction**: What was viewed/edited/decided
- **Goal Behavior**: What goals were pursued
- **Activity Pattern**: Focused or multi-threaded

## Output JSON Schema

{
  "title": "Debugging auth-service OAuth implementation",
  "summary": "## Core Tasks & Projects\n- Debugging OAuth2 token refresh in auth-service...",
  "highlights": [
    "Fixed OAuth token refresh bug",
    "Updated API documentation"
  ],
  "stats": {
    "top_apps": ["Visual Studio Code", "Google Chrome"],
    "top_entities": ["auth-service", "OAuth2"]
  },
  "events": [
    {
      "title": "Debugging OAuth2 implementation",
      "kind": "debugging",
      "start_offset_min": 0,
      "end_offset_min": 15,
      "confidence": 8,
      "importance": 7,
      "description": "Investigating and fixing OAuth2 token refresh issue in auth-service",
      "node_ids": [123, 124, 125]
    }
  ]
}

## Field Requirements

### title (required, ≤100 chars)
- One-line summary of the most significant activity
- Include project/task name when identifiable

### summary (required, Markdown format)
MUST contain exactly these 4 sections in order:

#### ## Core Tasks & Projects
- Main work activities with project names
- Extract from: file paths, git operations, IDE titles
- If none, output: "- None"

#### ## Key Discussion & Decisions
- Collaboration: Jira, Slack, Teams, PR reviews, meetings
- Summarize key points and outcomes
- If none, output: "- None"

#### ## Documents
- Wiki, docs, Confluence, README, API docs.
- **CRITICAL**: If a context node is of kind `knowledge`, summarize its content using its specific fields: `contentType`, `sourceUrl`, `projectOrLibrary`, and `keyInsight`. Provide a coherent summary of what was learned or referenced.
- EXCLUDE source code files (.ts, .js, etc.).
- Include URLs ONLY if visible.
- If none, output: "- None"

#### ## Next Steps
- Planned actions, TODOs
- If none, output: "- None"

### highlights (max 5)
- Key achievements or activities
- Short strings (≤80 chars each)

### stats
- MUST match input stats exactly
- Do NOT introduce new apps/entities

### events (1-3 candidates)
- Identify distinct activity periods within the window
- kind: Match activity type
- start_offset_min / end_offset_min: Minutes from window start (0-20)
- node_ids: Context node IDs that belong to this event

## Hard Rules

1. Output MUST be valid JSON only. No markdown fences.
2. All claims MUST be grounded in provided context nodes.
3. summary MUST contain exactly 4 sections in specified order.
4. stats MUST match input - do NOT invent apps/entities.
5. NEVER invent URLs not visible in evidence.
```

### User Prompt Template (EN)

```
Summarize user activity in this 20-minute window.

## Current Time Context
Current Unix timestamp (ms): {nowTs}

## Time Reference Points (Unix milliseconds, use these for time calculations!)
- Today start (00:00:00 local): {todayStart}
- Today end (23:59:59 local): {todayEnd}
- Yesterday start: {yesterdayStart}
- Yesterday end: {yesterdayEnd}
- One week ago: {weekAgo}

## Time Window
- Start: {windowStart} ({windowStartLocal})
- End: {windowEnd} ({windowEndLocal})

## Context Nodes in This Window
{contextNodesJson}

## Statistics
{statsJson}

## Instructions
1. Analyze all context nodes within this window.
2. Generate a comprehensive summary with exactly 4 sections.
3. Identify 1-3 distinct activity events.
4. Return ONLY the JSON object.
```

---

## Activity Event Details

### 输入 Schema

```typescript
interface EventDetailsUserPromptArgs {
  // 事件信息
  event: {
    event_id: number;
    title: string;
    kind: EventKind;
    start_ts: number;
    end_ts: number;
    thread_id: string | null;
  };
  
  // 关联的 context nodes（详细信息）
  context_nodes: DetailNode[];
  
  // 时间上下文
  nowTs: number;
  todayStart: number;
  todayEnd: number;
  yesterdayStart: number;
  yesterdayEnd: number;
  weekAgo: number;
}

interface DetailNode {
  node_id: number;
  title: string;
  summary: string;
  app_hint: string | null;
  knowledge_json: object | null;
  state_snapshot_json: object | null;
  entities_json: EntityRef[];
  action_items_json: object[] | null;
  event_time: number;
  local_time: string;
}
```

### 输出 Schema

```typescript
interface EventDetailsOutput {
  details: string;             // Markdown 格式详细报告
}
```

### System Prompt (EN)

```
You are a professional activity analysis assistant.

Your job: Generate a detailed, factual deep-dive report for ONE activity event.

## Quality Requirements

- **Faithful**: Do NOT invent facts (files, URLs, decisions, outcomes, numbers)
- **Structured**: Use clear headings and bullet lists
- **Comprehensive**: Cover all relevant aspects from the context nodes

## Output JSON Schema

{
  "details": "<markdown content>"
}

## Markdown Structure Guidelines

The details field should include relevant sections from:

### Overview
- What was the user doing?
- Primary goal/objective

### Timeline
- Key moments in chronological order
- Use local times from context nodes

### Key Activities
- Specific actions taken
- Files/resources accessed
- Decisions made

### Technical Details (if applicable)
- Technologies/tools involved
- Code changes or configurations
- Error resolution steps

### Outcomes
- What was accomplished?
- Any pending items?

### Related Entities
- Projects, repos, tickets mentioned
- People involved

## Hard Rules

1. Output MUST be valid JSON only: { "details": "<markdown>" }
2. All facts MUST come from provided context nodes.
3. NEVER invent URLs, file paths, or outcomes not in evidence.
4. Use local times from the context nodes.
5. Keep report focused on THIS specific event.
```

### User Prompt Template (EN)

```
Generate a detailed report for this activity event.

## Current Time Context
Current Unix timestamp (ms): {nowTs}

## Time Reference Points (Unix milliseconds, use these for time calculations!)
- Today start (00:00:00 local): {todayStart}
- Today end (23:59:59 local): {todayEnd}
- Yesterday start: {yesterdayStart}
- Yesterday end: {yesterdayEnd}
- One week ago: {weekAgo}

## Event Information
- Title: {event.title}
- Kind: {event.kind}
- Duration: {event.start_ts} to {event.end_ts}
- Thread: {event.thread_id || "None"}

## Associated Context Nodes
{contextNodesJson}

## Instructions
1. Analyze all context nodes to understand the full picture.
2. Generate a comprehensive markdown report.
3. Include all relevant sections based on available evidence.
4. Return ONLY the JSON object with "details" field.
```

---

## 设计原则总结

| 原则 | 描述 |
|-----|------|
| **One-to-One** | VLM: 每个截图产生一个 context node |
| **Grounded** | 所有信息必须基于截图可见证据，禁止编造 |
| **Language Detection** | VLM 识别 knowledge 语言，用于 OCR 触发判断 |
| **Thread Continuity** | Thread LLM 负责将节点组织到活动线索中 |
| **Structured Output** | 所有 prompt 要求严格 JSON 输出，无 markdown fences |
| **Field Constraints** | 每个字段有明确的长度限制和格式要求 |
