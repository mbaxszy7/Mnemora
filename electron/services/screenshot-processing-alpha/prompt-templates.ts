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
};
