import { generateObject, NoObjectGeneratedError } from "ai";

import type { ThreadBrief } from "@shared/thread-lens-types";

import { getLogger } from "../logger";
import { AISDKService } from "../ai-sdk-service";
import { aiRuntimeService } from "../ai-runtime-service";
import { llmUsageService } from "../llm-usage-service";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";

import { threadsService } from "./threads-service";
import { contextSearchService } from "./context-search-service";
import { processingConfig } from "./config";
import { promptTemplates } from "./prompt-templates";
import { ThreadBriefLLMSchema, ThreadBriefLLMProcessedSchema } from "./schemas";

const logger = getLogger("thread-brief-service");

type CacheKey = string;

function buildCacheKey(args: { threadId: string; lastActiveAt: number }): CacheKey {
  return `${args.threadId}:${args.lastActiveAt}`;
}

export class ThreadBriefService {
  private cache = new Map<CacheKey, ThreadBrief>();

  async getBrief(args: { threadId: string; force: boolean }): Promise<ThreadBrief | null> {
    const threadId = args.threadId.trim();
    if (!threadId) return null;

    const thread = threadsService.getThreadById(threadId);
    if (!thread) return null;

    const cacheKey = buildCacheKey({ threadId: thread.id, lastActiveAt: thread.lastActiveAt });
    if (!args.force) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const aiService = AISDKService.getInstance();
    if (!aiService.isInitialized()) {
      return null;
    }

    const recentNodes = await contextSearchService.getThread(threadId, { limit: 50 });

    const evidenceJson = JSON.stringify(
      recentNodes.map((n) => ({
        id: n.id,
        event_time: n.eventTime,
        kind: n.kind,
        title: n.title,
        summary: n.summary,
        app_hint: n.appContext?.appHint ?? null,
        window_title: n.appContext?.windowTitle ?? null,
        project_key: n.appContext?.projectKey ?? null,
        project_name: n.appContext?.projectName ?? null,
        keywords: n.keywords ?? [],
        entities: n.entities ?? [],
        knowledge: n.knowledge ?? null,
        state_snapshot: n.stateSnapshot ?? null,
      })),
      null,
      2
    );

    const threadJson = JSON.stringify(
      {
        id: thread.id,
        title: thread.title,
        summary: thread.summary,
        current_phase: thread.currentPhase ?? null,
        current_focus: thread.currentFocus ?? null,
        status: thread.status,
        start_time: thread.startTime,
        last_active_at: thread.lastActiveAt,
        duration_ms: thread.durationMs,
        node_count: thread.nodeCount,
        apps: thread.apps,
        main_project: thread.mainProject ?? null,
        key_entities: thread.keyEntities,
      },
      null,
      2
    );

    const userPrompt = promptTemplates.getThreadBriefUserPrompt({
      threadJson,
      evidenceJson,
    });

    const release = await aiRuntimeService.acquire("text");
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.textTimeoutMs);

    try {
      const { object, usage } = await generateObject({
        model: aiService.getTextClient(),
        schema: ThreadBriefLLMSchema,
        mode: "json",
        system: promptTemplates.getThreadBriefSystemPrompt(),
        prompt: userPrompt,
        abortSignal: controller.signal,
        providerOptions: {
          mnemora: {},
        },
      });

      const parsed = ThreadBriefLLMProcessedSchema.parse(object);
      const durationMs = Date.now() - startTime;

      await llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        status: "succeeded",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        totalTokens: usage?.totalTokens ?? 0,
        usageStatus: usage ? "present" : "missing",
      });

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        model: aiService.getTextModelName(),
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(parsed, null, 2),
      });

      aiRuntimeService.recordSuccess("text");

      const brief: ThreadBrief = {
        threadId: thread.id,
        lastActiveAt: thread.lastActiveAt,
        briefMarkdown: parsed.briefMarkdown,
        highlights: parsed.highlights,
        currentFocus: parsed.currentFocus,
        nextSteps: parsed.nextSteps,
        updatedAt: Date.now(),
      };

      this.cache.set(cacheKey, brief);
      return brief;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (NoObjectGeneratedError.isInstance(error)) {
        logger.error(
          {
            errorName: error.name,
            rawText: error.text,
            rawResponse: error.response,
            cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
          },
          "Thread brief NoObjectGeneratedError"
        );
      } else {
        logger.error({ error }, "Thread brief request failed");
      }

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        model: aiService.getTextModelName(),
        durationMs,
        status: "failed",
        errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });

      await llmUsageService.logEvent({
        ts: Date.now(),
        capability: "text",
        operation: "thread_brief",
        status: "failed",
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
        model: aiService.getTextModelName(),
        provider: "openai_compatible",
        usageStatus: "missing",
      });

      aiRuntimeService.recordFailure("text", error);
      return null;
    } finally {
      clearTimeout(timeoutId);
      release();
    }
  }
}

export const threadBriefService = new ThreadBriefService();
