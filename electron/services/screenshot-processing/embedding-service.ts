import { embed } from "ai";
import { getLogger } from "../logger";
import { AISDKService } from "../ai-sdk-service";
import { llmUsageService } from "../llm-usage-service";
import { processingConfig } from "./config";
import { aiRequestTraceBuffer } from "../monitoring/ai-request-trace";
import { aiRuntimeService } from "../ai-runtime-service";

const logger = getLogger("embedding-service");

export class EmbeddingService {
  async embed(text: string, abortSignal?: AbortSignal): Promise<Float32Array> {
    const embeddingClient = AISDKService.getInstance().getEmbeddingClient();
    const modelName = AISDKService.getInstance().getEmbeddingModelName();

    const release = await aiRuntimeService.acquire("embedding");
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), processingConfig.ai.embeddingTimeoutMs);
    const onAbort = () => controller.abort();
    abortSignal?.addEventListener("abort", onAbort);

    try {
      const result = await embed({
        model: embeddingClient,
        value: text,
        abortSignal: controller.signal,
        providerOptions: {
          mnemora: {
            dimensions: 1024,
          },
        },
      });

      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

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
