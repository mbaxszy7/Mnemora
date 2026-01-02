import { embed } from "ai";
import { getLogger } from "../logger";
import { AISDKService } from "../ai-sdk-service";
import { llmUsageService } from "../usage/llm-usage-service";
import { aiFailureCircuitBreaker } from "../ai-failure-circuit-breaker";

const logger = getLogger("embedding-service");

export class EmbeddingService {
  /**
   * Generate embedding for text using the configured embedding model
   */
  async embed(text: string, abortSignal?: AbortSignal): Promise<Float32Array> {
    const embeddingClient = AISDKService.getInstance().getEmbeddingClient();

    try {
      // Using ai sdk embed function
      const result = await embed({
        model: embeddingClient,
        value: text,
        abortSignal,
      });

      // Log usage

      llmUsageService.logEvent({
        ts: Date.now(),
        capability: "embedding",
        operation: "embedding_node",
        status: "succeeded",
        model: AISDKService.getInstance().getEmbeddingModelName(),
        provider: "openai_compatible",
        totalTokens: result.usage?.tokens ?? 0,
        usageStatus: result.usage ? "present" : "missing",
      });

      return new Float32Array(result.embedding);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to generate embedding"
      );

      // Record failure for circuit breaker
      aiFailureCircuitBreaker.recordFailure("embedding", error);

      throw error;
    }
  }
}

export const embeddingService = new EmbeddingService();
