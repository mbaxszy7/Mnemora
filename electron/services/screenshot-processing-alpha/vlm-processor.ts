import fs from "node:fs/promises";
import path from "node:path";

import { generateObject } from "ai";

import { processingConfig } from "./config";
import { promptTemplates } from "./prompt-templates";
import {
  VLMOutputProcessedSchema,
  VLMOutputSchema,
  type VLMContextNode,
  type VLMScreenshotMeta,
} from "./schemas";
import type { VlmBatchInput, VlmScreenshotInput } from "./types";
import { AISDKService } from "../ai-sdk-service";
import { aiRuntimeService } from "../ai-runtime-service";
import { llmUsageService } from "../llm-usage-service";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { getLogger } from "../logger";

const logger = getLogger("vlm-processor");

interface VLMRequest {
  system: string;
  userContent: Array<{ type: "text"; text: string } | { type: "image"; image: string }>;
}

class VLMProcessor {
  buildVLMRequest(screenshots: ScreenshotWithData[]): VLMRequest {
    const screenshotMeta = this.buildScreenshotMeta(screenshots);
    const userPrompt = this.buildUserPrompt(screenshotMeta);

    const userContent: VLMRequest["userContent"] = [{ type: "text", text: userPrompt }];

    for (const screenshot of screenshots) {
      if (!screenshot.base64) {
        continue;
      }
      const mime = screenshot.mime ?? "image/jpeg";
      userContent.push({
        type: "image",
        image: `data:${mime};base64,${screenshot.base64}`,
      });
    }

    return {
      system: promptTemplates.getVLMSystemPrompt(),
      userContent,
    };
  }

  async processBatch(batch: VlmBatchInput): Promise<VLMContextNode[]> {
    const aiService = AISDKService.getInstance();
    if (!aiService.isInitialized()) {
      throw new Error("AI SDK not initialized");
    }

    const screenshotsWithData = await this.loadBatchImages(batch.screenshots);
    const request = this.buildVLMRequest(screenshotsWithData);

    const release = await aiRuntimeService.acquire("vlm");
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.vlmTimeoutMs);

    try {
      const { object, usage } = await generateObject({
        model: aiService.getVLMClient(),
        schema: VLMOutputSchema,
        system: request.system,
        messages: [{ role: "user", content: request.userContent }],
        maxOutputTokens: processingConfig.ai.vlmMaxOutputTokens,
        abortSignal: controller.signal,
        providerOptions: {
          mnemora: {
            thinking: { type: "disabled" },
          },
        },
      });

      const parsed = VLMOutputProcessedSchema.parse(object);
      const durationMs = Date.now() - startTime;

      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "vlm",
        operation: "vlm_analyze_batch",
        status: "succeeded",
        model: aiService.getVLMModelName(),
        provider: "openai_compatible",
        totalTokens: usage?.totalTokens ?? 0,
        usageStatus: usage ? "present" : "missing",
      });

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "vlm",
        operation: "vlm_analyze_batch",
        model: aiService.getVLMModelName(),
        durationMs,
        status: "succeeded",
        responsePreview: JSON.stringify(parsed, null, 2),
        images: screenshotsWithData
          .filter((shot) => shot.base64)
          .map((shot) => `data:${shot.mime ?? "image/jpeg"};base64,${shot.base64}`),
      });

      aiRuntimeService.recordSuccess("vlm");

      return parsed.nodes;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "vlm",
        operation: "vlm_analyze_batch",
        model: aiService.getVLMModelName(),
        durationMs,
        status: "failed",
        errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        images: screenshotsWithData
          .filter((shot) => shot.base64)
          .map((shot) => `data:${shot.mime ?? "image/jpeg"};base64,${shot.base64}`),
      });

      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "vlm",
        operation: "vlm_analyze_batch",
        status: "failed",
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
        model: aiService.getVLMModelName(),
        provider: "openai_compatible",
        usageStatus: "missing",
      });

      aiRuntimeService.recordFailure("vlm", error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      release();
    }
  }

  private async loadBatchImages(screenshots: VlmScreenshotInput[]): Promise<ScreenshotWithData[]> {
    const results: ScreenshotWithData[] = [];

    for (const screenshot of screenshots) {
      let base64 = "";
      let mime: string | null = null;
      if (screenshot.filePath) {
        try {
          const buffer = await fs.readFile(screenshot.filePath);
          base64 = buffer.toString("base64");
          mime = inferMimeType(screenshot.filePath);
        } catch (error) {
          logger.warn(
            {
              screenshotId: screenshot.id,
              filePath: screenshot.filePath,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to load screenshot image"
          );
        }
      }

      results.push({
        ...screenshot,
        base64,
        mime,
      });
    }

    return results;
  }

  private buildScreenshotMeta(screenshots: ScreenshotWithData[]): VLMScreenshotMeta[] {
    return screenshots.map((s, index) => ({
      screenshot_index: index + 1,
      screenshot_id: s.id,
      captured_at: new Date(s.ts).toISOString(),
      source_key: s.sourceKey,
      app_hint: s.appHint ?? null,
      window_title: s.windowTitle ?? null,
    }));
  }

  private buildUserPrompt(screenshotMeta: VLMScreenshotMeta[]): string {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const utcOffsetMinutes = -now.getTimezoneOffset();
    const offsetSign = utcOffsetMinutes >= 0 ? "+" : "-";
    const offsetAbs = Math.abs(utcOffsetMinutes);
    const offsetHours = String(Math.floor(offsetAbs / 60)).padStart(2, "0");
    const offsetMins = String(offsetAbs % 60).padStart(2, "0");
    const utcOffset = `UTC${offsetSign}${offsetHours}:${offsetMins}`;

    const nowTs = now.getTime();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayEnd = new Date(todayEnd.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = nowTs - 7 * 24 * 60 * 60 * 1000;

    return promptTemplates.getVLMUserPrompt({
      count: screenshotMeta.length,
      localTime: now.toLocaleString("sv-SE", { timeZone, hour12: false }),
      timeZone,
      utcOffset,
      now,
      nowTs,
      todayStart: todayStart.getTime(),
      todayEnd: todayEnd.getTime(),
      yesterdayStart: yesterdayStart.getTime(),
      yesterdayEnd: yesterdayEnd.getTime(),
      weekAgo,
      screenshotMetaJson: JSON.stringify(screenshotMeta, null, 2),
    });
  }
}

interface ScreenshotWithData extends VlmScreenshotInput {
  base64: string;
  mime: string | null;
}

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/jpeg";
}

export const vlmProcessor = new VLMProcessor();
