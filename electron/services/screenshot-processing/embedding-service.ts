import { embed } from "ai";
import { getLogger } from "../logger";
import { AISDKService } from "../ai-sdk-service";

const logger = getLogger("embedding-service");

export class EmbeddingService {
  /**
   * Generate embedding for text using the configured embedding model
   */
  async embed(text: string): Promise<Float32Array> {
    const embeddingClient = AISDKService.getInstance().getEmbeddingClient();

    try {
      // Using ai sdk embed function
      const result = await embed({
        model: embeddingClient,
        value: text,
      });

      return new Float32Array(result.embedding);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to generate embedding"
      );
      throw error;
    }
  }
}

export const embeddingService = new EmbeddingService();
