import { mainI18n } from "../i18n-service";

export interface VLMUserPromptArgs {
  count: number;
  localTime: string;
  timeZone: string;
  utcOffset: string;
  now: Date;
  nowTs: number;
  todayStart: number;
  todayEnd: number;
  yesterdayStart: number;
  yesterdayEnd: number;
  weekAgo: number;
  screenshotMetaJson: string;
}

export interface ThreadLLMUserPromptArgs {
  activeThreadsJson: string;
  threadRecentNodesJson: string;
  batchNodesJson: string;
  localTime: string;
  timeZone: string;
  now: Date;
  nowTs: number;
  todayStart: number;
  todayEnd: number;
  yesterdayStart: number;
  yesterdayEnd: number;
  weekAgo: number;
}

export interface QueryUnderstandingUserPromptArgs {
  nowDate: Date;
  nowTs: number;
  timeZone: string;
  todayStart: number;
  todayEnd: number;
  yesterdayStart: number;
  yesterdayEnd: number;
  weekAgo: number;
  canonicalCandidatesJson: string;
  userQuery: string;
}

export interface AnswerSynthesisUserPromptArgs {
  userQuery: string;
  localTime: string;
  timeZone: string;
  nowDate: Date;
  formattedTimeSpanStart: string;
  formattedTimeSpanEnd: string;
  topAppsStr: string;
  topEntitiesStr: string;
  kindsStr: string;
  nodesJson: string;
  evidenceJson: string;
}

// ============================================================================
// VLM Processor Prompts (Alpha)
// ============================================================================

const VLM_SYSTEM_PROMPT_EN = `You are an expert screenshot analyst for a personal activity tracking system.

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
      "screenshot_index": 1,
      "title": "current_user debugging TypeScript compilation error in auth-service",
      "summary": "current_user viewing VS Code with TypeScript compilation error in auth-service project, the error indicates a missing property on AuthResponse type",
      "app_context": {
        "app_hint": "Visual Studio Code",
        "window_title": "auth.ts - auth-service",
        "source_key": "window:123"
      },
      "knowledge": null,
      "state_snapshot": {
        "subject_type": "error",
        "subject": "TypeScript Compilation",
        "current_state": "failed with 1 error",
        "issue": {
          "detected": true,
          "type": "error",
          "description": "Property 'refreshToken' does not exist on type 'AuthResponse'",
          "severity": 3
        }
      },
      "entities": [
        { "name": "auth-service", "type": "repo" },
        { "name": "AuthResponse", "type": "other" }
      ],
      "action_items": [
        { "action": "Add refreshToken property to AuthResponse interface", "priority": "high", "source": "inferred" }
      ],
      "ui_text_snippets": ["Property 'refreshToken' does not exist on type 'AuthResponse'", "TS2339"],
      "importance": 7,
      "confidence": 9,
      "keywords": ["TypeScript", "compilation error", "auth-service"]
    }
  ]
}

## Field Requirements

### title (required, ≤100 chars)
- MUST start with "current_user" as subject
- MUST include project/repo name when identifiable
- Action-oriented: describe what user is DOING

### summary (required, ≤500 chars)
- Detailed description of the activity
- Include: app being used, specific task, progress indicators, key identifiers

### app_context (required)
- app_hint: ONLY return a canonical app name if it matches a popular/common app (e.g., Chrome, VS Code, Slack). Otherwise, return null.
- window_title: Preserve original window title if identifiable, otherwise null.
- source_key: Pass through from input metadata.

### knowledge (optional)
- Only populate if user is reading documentation, blogs, tutorials
- content_type: tech_doc|blog|product_doc|tutorial|api_doc|wiki|other
- language: "en" | "zh" | "other" ("en"/"zh" triggers OCR)
- text_region: IMPORTANT for OCR optimization

### state_snapshot (optional)
- Populate if dashboards/metrics/build status or issues are visible
- issue: If error/bug/blocker/warning detected, fill issue object

### entities (max 10)
- Named entities only; exclude generic terms
- type MUST be one of: person, project, team, org, jira_id, pr_id, commit, document_id, url, repo, other
- Include raw/confidence when visible

### action_items (optional)
- Only if explicit TODOs/next steps are visible
- source: "explicit" or "inferred"

### ui_text_snippets (max 5, each ≤200 chars)
- High-signal UI text: headers, key messages, errors

### importance/confidence (0-10)

### keywords (max 5)

## Hard Rules
1. Output MUST be valid JSON only. No markdown fences.
2. Output exactly one node per input screenshot.
3. screenshot_index must match the input screenshot order (1-based).
4. NEVER invent URLs - only include if clearly visible.
5. NEVER hallucinate facts.
6. If no knowledge content, set knowledge: null.
7. If no state snapshot, set state_snapshot: null.
8. If no action items, set action_items: null.`;

const VLM_SYSTEM_PROMPT_ZH = VLM_SYSTEM_PROMPT_EN;

const VLM_USER_PROMPT_EN = (
  args: VLMUserPromptArgs
) => `Analyze the following ${args.count} screenshots and produce the structured JSON described in the system prompt.

## Current User Time Context
Current time: ${args.now.toISOString()}
Current Unix timestamp (ms): ${args.nowTs}
Timezone: ${args.timeZone}
UTC Offset: ${args.utcOffset}

## Time Reference Points (Unix milliseconds)
- Today start (00:00 local): ${args.todayStart}
- Today end (23:59:59 local): ${args.todayEnd}
- Yesterday start: ${args.yesterdayStart}
- Yesterday end: ${args.yesterdayEnd}
- One week ago: ${args.weekAgo}

## Screenshot Metadata (order = screenshot_index)
${args.screenshotMetaJson}

## Instructions
1. Review all screenshots in order (1..${args.count}).
2. Extract one context node per screenshot based ONLY on visual evidence.
3. Return ONLY the JSON object - no extra text or code fences.`;

const VLM_USER_PROMPT_ZH = VLM_USER_PROMPT_EN;

// =========================================================================
// Thread LLM Prompts
// =========================================================================

const THREAD_LLM_SYSTEM_PROMPT_EN = `You are an activity thread analyzer. Your task is to organize context nodes into coherent activity threads.

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
      "node_indices": [1],
      "milestones": [
        "Started researching PostgreSQL query optimization techniques for analytics pipeline"
      ]
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
- milestones: Initial milestones (rich description). MUST be an array (can be empty).

## Hard Rules

1. Output MUST be valid JSON only. No markdown fences.
2. EVERY input node MUST have exactly one assignment.
3. If using "NEW", there MUST be a corresponding entry in new_threads.
4. thread_id in assignments MUST be either an exact UUID from input OR "NEW".
5. Do NOT create a new thread if activity clearly continues an existing thread.
6. Do NOT merge unrelated activities into one thread.
7. assignments MUST be sorted by node_index ascending.
8. Only use thread_id values that appear in the Active Threads input; do NOT invent UUIDs.
9. Prefer fewer threads: if multiple batch nodes describe the same new activity, group them into one new_threads entry.
10. new_threads[].node_indices MUST contain exactly the nodes assigned to that new thread (no extra nodes; no missing nodes).`;

const THREAD_LLM_SYSTEM_PROMPT_ZH = THREAD_LLM_SYSTEM_PROMPT_EN;

const THREAD_LLM_USER_PROMPT_EN = (
  args: ThreadLLMUserPromptArgs
) => `Analyze the following batch of context nodes and assign them to threads.

## Current Time Context
Current time: ${args.now.toISOString()}
Current Unix timestamp (ms): ${args.nowTs}
Timezone: ${args.timeZone}

## Time Reference Points (Unix milliseconds, use these for time calculations!)
- Today start (00:00:00 local): ${args.todayStart}
- Today end (23:59:59 local): ${args.todayEnd}
- Yesterday start: ${args.yesterdayStart}
- Yesterday end: ${args.yesterdayEnd}
- One week ago: ${args.weekAgo}

## Active Threads (most recent first)
${args.activeThreadsJson}

## Each Thread's Recent Nodes (Faithful Context)
${args.threadRecentNodesJson}

## New Nodes from This Batch (to be assigned)
${args.batchNodesJson}

## Instructions
1. For each new node, determine the best thread assignment.
2. Use existing thread_id if activity continues that thread.
3. Use "NEW" if this is a clearly different activity.
4. Update thread metadata (phase, focus, milestones) using high-information, rich descriptions.
5. Return ONLY the JSON object - no extra text.`;

const THREAD_LLM_USER_PROMPT_ZH = THREAD_LLM_USER_PROMPT_EN;

// =========================================================================
// Deep Search Prompts
// =========================================================================

const QUERY_UNDERSTANDING_SYSTEM_PROMPT_EN = `You are a search query analyzer. Your task is to parse a user's natural language query and extract structured search parameters.

## Output Schema (JSON only)

{
  "embedding_text": string,     // Optimized text for semantic search (normalized entities, clear intent)
  "filters_patch": {            // Optional extracted filters
    "time_range": { "start": number, "end": number }, // Unix timestamps in milliseconds
    "app_hint": string,         // Application name if mentioned (MUST be one of Canonical App Candidates)
    "entities": string[]        // Entity names mentioned (0-20, see rules)
  },
  "kind_hint": "event" | "knowledge" | "state_snapshot",
  "extracted_entities": [ { "name": string, "type": string, "raw": string, "confidence": number } ],
  "keywords": string[],         // 0-10 high-signal keywords for exact SQL matching
  "time_range_reasoning": string, // Brief explanation of time parsing
  "confidence": number          // 0-1
}

## Rules

1. **embedding_text**: Rephrase the query for better semantic matching. Remove filler words, normalize entity names.
2. **filters_patch.time_range**: Only include if user explicitly mentions time (e.g., "yesterday", "last week", "in March").
3. **filters_patch.app_hint**: Only include if user mentions a specific application. If provided, it MUST be one of the Canonical App Candidates provided in the prompt.
4. **Do NOT include thread_id** in filters_patch - that's user-controlled context.
5. **kind_hint**: Infer what type of information the user is looking for.
6. **confidence**: Set lower if query is ambiguous or you're uncertain about extractions.
7. **extracted_entities** rules:
   - 0-20 canonical named entities across the query.
   - Only meaningful named entities (person/project/team/org/app/repo/issue/ticket like "ABC-123").
   - type MUST be one of: person, project, team, org, jira_id, pr_id, commit, document_id, url, repo, other.
   - EXCLUDE generic tech terms, libraries, commands, file paths, and folders like "npm", "node_modules", "dist", ".git".
   - EXCLUDE URLs without meaningful names.
   - Deduplicate and prefer canonical names.

## Important

- Return ONLY valid JSON, no markdown or explanations.
- If you cannot parse the query meaningfully, set confidence to 0.`;

const QUERY_UNDERSTANDING_SYSTEM_PROMPT_ZH = `你是一个搜索查询分析器。你的任务是解析用户的自然语言查询并提取结构化的搜索参数。

## 输出模式 (仅 JSON)

{
  "embedding_text": 字符串,     // 用于语义搜索的优化文本（规范化实体，明确意图）
  "filters_patch": {            // 可选的提取过滤器
    "time_range": { "start": 数字, "end": 数字 }, // Unix 毫秒级时间戳
    "app_hint": 字符串,         // 如果提到则为应用名称（必须是“规范应用候选”之一）
    "entities": 字符串数组       // 提到的实体名称 (0-20, 见规则)
  },
  "kind_hint": "event" | "knowledge" | "state_snapshot",
  "extracted_entities": [ { "name": 字符串, "type": 字符串, "raw": 字符串, "confidence": 数字 } ],
  "keywords": 字符串数组,        // 用于精确匹配的 0-10 个高信号关键词
  "time_range_reasoning": 字符串, // 时间解析的简要说明
  "confidence": 数字           // 0-1
}

## 规则

1. **embedding_text**：为了更好的语义匹配，请重新描述查询。移除填充词，规范化实体名称。
2. **filters_patch.time_range**：仅当用户明确提到时间（例如“昨天”、“上周”、“三月”）时才包含。
3. **filters_patch.app_hint**：仅当用户提到特定应用程序时才包含。如果提供，它必须在提示中提供的“规范应用候选”列表中。
4. **不要在 filters_patch 中包含 thread_id** - 这是受用户控制的上下文。
5. **kind_hint**：推断用户正在寻找的信息类型。
6. **confidence**：如果查询含糊不清或对提取不确定，请设置较低的置信度。
7. **extracted_entities** 规则：
   - 整个查询中 0-20 个规范的命名实体。
   - 仅包含有意义的命名实体（人物/项目/团队/组织/应用/仓库/Issue/任务单，如 "ABC-123"）。
   - type 必须为：person, project, team, org, jira_id, pr_id, commit, document_id, url, repo, other
   - 排除通用技术术语、库、命令、文件路径和文件夹，如 "npm", "node_modules", "dist", ".git"。
   - 排除没有意义名称的 URL。
   - 去重并优先使用规范名称。

## 重要提示

- 仅返回有效的 JSON，不要有 markdown 或说明。
- 如果无法有意义地解析查询，请将置信度设置为 0。`;

const ANSWER_SYNTHESIS_SYSTEM_PROMPT_EN = `You are a context-aware answer synthesizer. Your task is to generate a concise, accurate answer based on search results.

## Input

You will receive:
1. The user's original query
2. Current User Time (local time and timezone)
3. Retrieved context nodes with these fields:
   - id, kind, title, summary, keywords, entities (array of names), event_time, local_time, thread_id, screenshot_ids
4. Screenshot evidence with these fields:
   - screenshot_id, timestamp, local_time, app_hint, window_title, ui_snippets

## Output Schema (JSON only)

{
  "answer_title": string,       // Optional short title for the answer (≤100 chars)
  "answer": string,             // Main answer text (concise, factual)
  "bullets": string[],          // Key bullet points (≤8 items)
  "citations": [                // References to source nodes/screenshots
    { "node_id": number, "screenshot_id": number, "quote": string }
  ],
  "confidence": number          // 0-1, based on evidence quality
}

## Rules

1. **Faithfulness**: ONLY use information from the provided context. Do NOT invent facts.
2. **Local Time Enforcement**: ALL times in your answer (answer text, bullets) MUST be in the User's Local Time format (e.g., "14:30" or "2:30 PM").
3. **Citations required**: Every claim must have at least one citation. Use node_id or screenshot_id from the input.
4. **Quote**: Short excerpt (≤80 chars) from the source as evidence. No sensitive information.
5. **Confidence**: Set lower if evidence is sparse or contradictory. Set very low if no relevant evidence.
6. **answer**: Keep concise and directly address the query.

## Important

- Return ONLY valid JSON, no markdown or explanations.
- If no relevant information is found, set confidence to 0.1 and explain in the answer.`;

const ANSWER_SYNTHESIS_SYSTEM_PROMPT_ZH = `你是一个上下文感知的答案合成器。你的任务是根据搜索结果生成简洁、准确的答案。

## 输入

你将收到：
1. 用户的原始查询
2. 当前用户时间（本地时间和时区）
3. 检索到的上下文节点，包含以下字段：
   - id, kind, title, summary, keywords, entities (名称数组), event_time, local_time, thread_id, screenshot_ids
4. 截图证据，包含以下字段：
   - screenshot_id, timestamp, local_time, app_hint, window_title, ui_snippets

## 输出模式 (仅 JSON)

{
  "answer_title": 字符串,       // 答案的可选短标题 (≤100 字符)
  "answer": 字符串,             // 答案正文（简洁、真实）
  "bullets": 字符串数组,          // 关键点 (≤8 项)
  "citations": [                // 对源节点/截图的引用
    { "node_id": 数字, "screenshot_id": 数字, "quote": 字符串 }
  ],
  "confidence": 数字           // 0-1, 基于证据质量
}

## 规则

1. **忠实度**：仅使用提供的上下文中的信息。不得捏造事实。
2. **本地时间强制要求**：答案（正文、要点）中的所有时间必须采用用户的本地时间格式（例如 "14:30" 或 "2:30 PM"）。
3. **必须包含引用**：每个声明必须至少有一个引用。使用输入中的 node_id 或 screenshot_id。
4. **引用文段**：来自源的短摘录 (≤80 字符) 作为证据。不得包含敏感信息。
5. **置信度**：如果证据稀疏或矛盾，请设置较低数值。如果没有相关证据，请设置极低数值。
6. **answer**：保持简洁并直接回答查询。

## 重要提示

- 仅返回有效的 JSON，不要有 markdown 或说明。
- 如果未找到相关信息，请将置信度设置为 0.1 并在答案中说明。`;

const QUERY_UNDERSTANDING_USER_PROMPT_EN = (
  args: QueryUnderstandingUserPromptArgs
) => `Current time: ${args.nowDate.toISOString()}
Current Unix timestamp (ms): ${args.nowTs}
Timezone: ${args.timeZone}

## Time Reference Points (Unix milliseconds, use these for time calculations!)
- Today start (00:00:00 local): ${args.todayStart}
- Today end (23:59:59 local): ${args.todayEnd}
- Yesterday start: ${args.yesterdayStart}
- Yesterday end: ${args.yesterdayEnd}
- One week ago: ${args.weekAgo}

## Canonical App Candidates (for filters_patch.app_hint)
${args.canonicalCandidatesJson}

## App mapping rules (critical)
- filters_patch.app_hint MUST be a canonical name from the list above.
- If the user query uses an alias like "chrome", "google chrome", etc., map it to the canonical app name.
- If you cannot confidently map to one canonical app, OMIT filters_patch.app_hint.

## Time calculation rules (critical)
- ALWAYS use the Time Reference Points above for calculating filters_patch.time_range.
- For "today", use Today start and Today end timestamps directly.
- For "yesterday", use Yesterday start and Yesterday end timestamps directly.
- Do NOT calculate Unix timestamps from scratch - use the provided reference points!

User query: "${args.userQuery}"

Parse this query and return the structured search parameters.`;

const QUERY_UNDERSTANDING_USER_PROMPT_ZH = (
  args: QueryUnderstandingUserPromptArgs
) => `当前时间：${args.nowDate.toISOString()}
当前 Unix 时间戳（毫秒）：${args.nowTs}
时区：${args.timeZone}

## 时间参考点（Unix 毫秒，用于时间计算！）
- 今天开始 (00:00:00 本地)：${args.todayStart}
- 今天结束 (23:59:59 本地)：${args.todayEnd}
- 昨天开始：${args.yesterdayStart}
- 昨天结束：${args.yesterdayEnd}
- 一周前：${args.weekAgo}

## 规范应用候选（用于 filters_patch.app_hint）
${args.canonicalCandidatesJson}

## 应用映射规则（关键）
- filters_patch.app_hint 必须是上述列表中的规范名称。
- 如果用户查询使用别名如 "chrome", "google chrome" 等，请将其映射到规范的应用名称。
- 如果无法自信地映射到一个规范应用，请省略 filters_patch.app_hint。

## 时间计算规则（关键）
- 始终使用上面的时间参考点计算 filters_patch.time_range。
- 对于 "今天" (today)，直接使用今天开始和今天结束时间戳。
- 对于 "昨天" (yesterday)，直接使用昨天开始和昨天结束时间戳。
- 不要从头开始计算 Unix 时间戳 - 使用提供的参考点！

用户查询："${args.userQuery}"

解析此查询并返回结构化搜索参数。`;

const ANSWER_SYNTHESIS_USER_PROMPT_EN = (args: AnswerSynthesisUserPromptArgs) => `## User Query
"${args.userQuery}"

## Current User Time
- local_time: ${args.localTime}
- time_zone: ${args.timeZone}
- now_utc: ${args.nowDate.toISOString()}

## Global Summary
- Time span: ${args.formattedTimeSpanStart} to ${args.formattedTimeSpanEnd}
- Top apps: ${args.topAppsStr}
- Top entities: ${args.topEntitiesStr}
- Kinds: ${args.kindsStr}

## Context Nodes
${args.nodesJson}

## Screenshot Evidence
${args.evidenceJson}

Based on the above context, provide a structured answer to the user's query. Remember to use ONLY the local time zone (${args.timeZone}) for all time references in your answer.`;

const ANSWER_SYNTHESIS_USER_PROMPT_ZH = (args: AnswerSynthesisUserPromptArgs) => `## 用户查询
"${args.userQuery}"

## 当前用户时间
- local_time: ${args.localTime}
- time_zone: ${args.timeZone}
- now_utc: ${args.nowDate.toISOString()}

## 全局摘要
- 时间跨度：${args.formattedTimeSpanStart} 至 ${args.formattedTimeSpanEnd}
- Top apps: ${args.topAppsStr}
- Top entities: ${args.topEntitiesStr}
- Kinds: ${args.kindsStr}

## 上下文节点
${args.nodesJson}

## 截图证据
${args.evidenceJson}

基于以上上下文，为用户查询生成结构化答案。请确保所有时间引用均使用本地时间 (${args.timeZone})。`;

export const promptTemplates = {
  getVLMSystemPrompt(): string {
    return mainI18n.getCurrentLanguage() === "zh-CN" ? VLM_SYSTEM_PROMPT_ZH : VLM_SYSTEM_PROMPT_EN;
  },
  getVLMUserPrompt(args: VLMUserPromptArgs): string {
    return mainI18n.getCurrentLanguage() === "zh-CN"
      ? VLM_USER_PROMPT_ZH(args)
      : VLM_USER_PROMPT_EN(args);
  },
  getThreadLlmSystemPrompt(): string {
    return mainI18n.getCurrentLanguage() === "zh-CN"
      ? THREAD_LLM_SYSTEM_PROMPT_ZH
      : THREAD_LLM_SYSTEM_PROMPT_EN;
  },
  getThreadLlmUserPrompt(args: ThreadLLMUserPromptArgs): string {
    return mainI18n.getCurrentLanguage() === "zh-CN"
      ? THREAD_LLM_USER_PROMPT_ZH(args)
      : THREAD_LLM_USER_PROMPT_EN(args);
  },
  getQueryUnderstandingSystemPrompt(): string {
    return mainI18n.getCurrentLanguage() === "zh-CN"
      ? QUERY_UNDERSTANDING_SYSTEM_PROMPT_ZH
      : QUERY_UNDERSTANDING_SYSTEM_PROMPT_EN;
  },
  getQueryUnderstandingUserPrompt(args: QueryUnderstandingUserPromptArgs): string {
    return mainI18n.getCurrentLanguage() === "zh-CN"
      ? QUERY_UNDERSTANDING_USER_PROMPT_ZH(args)
      : QUERY_UNDERSTANDING_USER_PROMPT_EN(args);
  },
  getAnswerSynthesisSystemPrompt(): string {
    return mainI18n.getCurrentLanguage() === "zh-CN"
      ? ANSWER_SYNTHESIS_SYSTEM_PROMPT_ZH
      : ANSWER_SYNTHESIS_SYSTEM_PROMPT_EN;
  },
  getAnswerSynthesisUserPrompt(args: AnswerSynthesisUserPromptArgs): string {
    return mainI18n.getCurrentLanguage() === "zh-CN"
      ? ANSWER_SYNTHESIS_USER_PROMPT_ZH(args)
      : ANSWER_SYNTHESIS_USER_PROMPT_EN(args);
  },
};
