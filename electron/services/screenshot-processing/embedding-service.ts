import { embed } from "ai";
import { getLogger } from "../logger";
import { AISDKService } from "../ai-sdk-service";
import { llmUsageService } from "../llm-usage-service";
import { aiConcurrencyConfig } from "./config";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { aiRuntimeService } from "../ai-runtime-service";

const logger = getLogger("embedding-service");

export class EmbeddingService {
  /**
   * Generate embedding for text using the configured embedding model
   */
  async embed(text: string, abortSignal?: AbortSignal): Promise<Float32Array> {
    const startTime = Date.now();
    const embeddingClient = AISDKService.getInstance().getEmbeddingClient();
    const modelName = AISDKService.getInstance().getEmbeddingModelName();

    // Acquire global embedding semaphore
    const release = await aiRuntimeService.acquire("embedding");

    // Setup timeout with AbortController (combine with external signal if provided)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), aiConcurrencyConfig.embeddingTimeoutMs);

    // If external abort signal is provided, forward abort to our controller
    const onAbort = () => controller.abort();
    abortSignal?.addEventListener("abort", onAbort);

    try {
      // Using ai sdk embed function
      const result = await embed({
        model: embeddingClient,
        value: text,
        abortSignal: controller.signal,
      });

      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      // Log usage
      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "embedding",
        operation: "embedding_node",
        status: "succeeded",
        model: modelName,
        provider: "openai_compatible",
        totalTokens: result.usage?.tokens ?? 0,
        usageStatus: result.usage ? "present" : "missing",
      });

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "embedding",
        operation: "embedding_node",
        model: modelName,
        durationMs,
        status: "succeeded",
        responsePreview: `Embedding generated: ${result.embedding.length} dimensions`,
      });

      aiRuntimeService.recordSuccess("embedding");

      return new Float32Array(result.embedding);
    } catch (error) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to generate embedding"
      );

      // Record trace for monitoring dashboard
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "embedding",
        operation: "embedding_node",
        model: modelName,
        durationMs,
        status: "failed",
        errorPreview: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });

      aiRuntimeService.recordFailure("embedding", error);

      throw error;
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
      release();
    }
  }
}

export const embeddingService = new EmbeddingService();
