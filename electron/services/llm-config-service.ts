/**
 * LLM Configuration Service
 * Manages LLM configuration storage, loading, and validation
 */

import { eq } from "drizzle-orm";
import { generateText, embed } from "ai";
import { getDb, llmConfig, type LLMConfigRecord } from "../database";
import { getLogger } from "./logger";
import { AISDKService } from "./ai-sdk-service";
import {
  LLMConfig,
  LLMConfigCheckResult,
  LLMValidationResult,
  LLMValidationErrorCode,
  CapabilityValidationResult,
} from "@shared/llm-config-types";
import { encodeApiKey, decodeApiKey, isEndpointConfigComplete } from "@shared/llm-config-utils";

const logger = getLogger("llm-config-service");

/**
 * LLM Configuration Service - Singleton
 * Handles configuration persistence, loading, and validation
 */
export class LLMConfigService {
  private static instance: LLMConfigService | null = null;

  private constructor() {}

  static getInstance(): LLMConfigService {
    if (!LLMConfigService.instance) {
      LLMConfigService.instance = new LLMConfigService();
    }
    return LLMConfigService.instance;
  }

  static resetInstance(): void {
    LLMConfigService.instance = null;
  }

  /**
   * Check if valid LLM configuration exists in the database
   * @returns Configuration check result with configured status and config if exists
   */
  async checkConfiguration(): Promise<LLMConfigCheckResult> {
    logger.debug("Checking LLM configuration status");

    try {
      const config = await this.loadConfiguration();

      if (!config) {
        logger.info("No LLM configuration found");
        return { configured: false };
      }

      // Verify configuration completeness
      if (config.mode === "unified") {
        if (!isEndpointConfigComplete(config.config)) {
          logger.info("Unified configuration incomplete");
          return { configured: false };
        }
      } else {
        // Separate mode - all three must be complete
        if (
          !isEndpointConfigComplete(config.vlm) ||
          !isEndpointConfigComplete(config.textLlm) ||
          !isEndpointConfigComplete(config.embeddingLlm)
        ) {
          logger.info("Separate configuration incomplete");
          return { configured: false };
        }
      }

      logger.info({ mode: config.mode }, "Valid LLM configuration found");
      return { configured: true, config };
    } catch (error) {
      logger.error({ error }, "Error checking configuration");
      return { configured: false };
    }
  }

  /**
   * Load LLM configuration from database and decode API keys
   * @returns The loaded configuration or null if not found
   */
  async loadConfiguration(): Promise<LLMConfig | null> {
    logger.debug("Loading LLM configuration from database");

    try {
      // Get the single config record (singleton pattern)
      const db = getDb();
      const record = db.select().from(llmConfig).get();

      if (!record) {
        return null;
      }

      return this.recordToConfig(record);
    } catch (error) {
      logger.error({ error }, "Error loading configuration");
      return null;
    }
  }

  /**
   * Save LLM configuration to database with encoded API keys
   * Also reinitializes AISDKService with the new configuration
   * @param config - The configuration to save
   */
  async saveConfiguration(config: LLMConfig): Promise<void> {
    logger.info({ mode: config.mode }, "Saving LLM configuration");

    try {
      const db = getDb();
      // Check if record exists
      const existing = db.select().from(llmConfig).get();

      const record = this.configToRecord(config);

      if (existing) {
        // Update existing record
        db.update(llmConfig)
          .set({ ...record, updatedAt: new Date() })
          .where(eq(llmConfig.id, existing.id))
          .run();
      } else {
        // Insert new record
        db.insert(llmConfig).values(record).run();
      }

      // Reinitialize AISDKService with the saved configuration
      const aiService = AISDKService.getInstance();
      aiService.initialize(config);
      logger.info("ai sdk service initialized after saving LLM configuration");

      logger.info("LLM configuration saved and AISDKService reinitialized successfully");
    } catch (error) {
      logger.error({ error }, "Error saving configuration");
      throw error;
    }
  }

  /**
   * Convert database record to LLMConfig
   */
  private recordToConfig(record: LLMConfigRecord): LLMConfig | null {
    if (record.mode === "unified") {
      if (!record.unifiedBaseUrl || !record.unifiedApiKey || !record.unifiedModel) {
        return null;
      }
      return {
        mode: "unified",
        config: {
          baseUrl: record.unifiedBaseUrl,
          apiKey: decodeApiKey(record.unifiedApiKey),
          model: record.unifiedModel,
        },
      };
    } else {
      // Separate mode
      if (
        !record.vlmBaseUrl ||
        !record.vlmApiKey ||
        !record.vlmModel ||
        !record.textLlmBaseUrl ||
        !record.textLlmApiKey ||
        !record.textLlmModel ||
        !record.embeddingBaseUrl ||
        !record.embeddingApiKey ||
        !record.embeddingModel
      ) {
        return null;
      }
      return {
        mode: "separate",
        vlm: {
          baseUrl: record.vlmBaseUrl,
          apiKey: decodeApiKey(record.vlmApiKey),
          model: record.vlmModel,
        },
        textLlm: {
          baseUrl: record.textLlmBaseUrl,
          apiKey: decodeApiKey(record.textLlmApiKey),
          model: record.textLlmModel,
        },
        embeddingLlm: {
          baseUrl: record.embeddingBaseUrl,
          apiKey: decodeApiKey(record.embeddingApiKey),
          model: record.embeddingModel,
        },
      };
    }
  }

  /**
   * Convert LLMConfig to database record format
   */
  private configToRecord(
    config: LLMConfig
  ): Omit<LLMConfigRecord, "id" | "createdAt" | "updatedAt"> {
    if (config.mode === "unified") {
      return {
        mode: "unified",
        unifiedBaseUrl: config.config.baseUrl,
        unifiedApiKey: encodeApiKey(config.config.apiKey),
        unifiedModel: config.config.model,
        // Clear separate mode fields
        vlmBaseUrl: null,
        vlmApiKey: null,
        vlmModel: null,
        textLlmBaseUrl: null,
        textLlmApiKey: null,
        textLlmModel: null,
        embeddingBaseUrl: null,
        embeddingApiKey: null,
        embeddingModel: null,
      };
    } else {
      return {
        mode: "separate",
        // Clear unified mode fields
        unifiedBaseUrl: null,
        unifiedApiKey: null,
        unifiedModel: null,
        // Set separate mode fields
        vlmBaseUrl: config.vlm.baseUrl,
        vlmApiKey: encodeApiKey(config.vlm.apiKey),
        vlmModel: config.vlm.model,
        textLlmBaseUrl: config.textLlm.baseUrl,
        textLlmApiKey: encodeApiKey(config.textLlm.apiKey),
        textLlmModel: config.textLlm.model,
        embeddingBaseUrl: config.embeddingLlm.baseUrl,
        embeddingApiKey: encodeApiKey(config.embeddingLlm.apiKey),
        embeddingModel: config.embeddingLlm.model,
      };
    }
  }

  /**
   * Validate LLM configuration by testing API calls
   * Temporarily initializes AISDKService to test the configuration
   * After validation, restores the previous configuration if validation fails
   * @param config - The configuration to validate
   * @returns Validation result with success status and individual capability results
   */
  async validateConfiguration(config: LLMConfig): Promise<LLMValidationResult> {
    logger.info({ mode: config.mode, config }, "Validating LLM configuration");

    const aiService = AISDKService.getInstance();

    // Save the current configuration to restore if validation fails
    const previousConfig = await this.loadConfiguration();

    // Initialize AISDKService with the candidate config before validation
    try {
      aiService.initialize(config);
    } catch (initError) {
      logger.warn({ error: initError }, "Failed to initialize AISDKService with candidate config");
      return {
        success: false,
        textCompletion: { success: false, error: LLMValidationErrorCode.UNKNOWN },
        vision: { success: false, error: LLMValidationErrorCode.UNKNOWN },
        embedding: { success: false, error: LLMValidationErrorCode.UNKNOWN },
      };
    }

    // Validate all capabilities in parallel
    const [textResult, visionResult, embeddingResult] = await Promise.all([
      this.validateTextCompletion(aiService),
      this.validateVision(aiService),
      this.validateEmbedding(aiService),
    ]);

    const success = textResult.success && visionResult.success && embeddingResult.success;

    // If validation failed and we had a previous valid config, restore it
    if (!success && previousConfig) {
      logger.debug("Validation failed, restoring previous configuration");
      try {
        aiService.initialize(previousConfig);
      } catch (restoreError) {
        logger.warn({ error: restoreError }, "Failed to restore previous configuration");
      }
    }

    return {
      success,
      textCompletion: textResult,
      vision: visionResult,
      embedding: embeddingResult,
    };
  }

  /**
   * Validate text completion capability
   */
  private async validateTextCompletion(
    aiService: AISDKService
  ): Promise<CapabilityValidationResult> {
    logger.debug("Validating text completion");

    try {
      await generateText({
        model: aiService.getTextClient(),
        prompt: "Say hello",
        maxOutputTokens: 10,
      });

      logger.debug("Text completion validation successful");
      return { success: true };
    } catch (error) {
      const errorCode = this.mapErrorToCode(error);
      logger.warn({ error, errorCode }, "Text completion validation failed");
      return { success: false, error: errorCode };
    }
  }

  /**
   * Validate vision capability
   */
  private async validateVision(aiService: AISDKService): Promise<CapabilityValidationResult> {
    logger.debug("Validating vision capability");

    try {
      // Minimal 10x10 red pixel PNG as base64
      const minimalPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGP4z8DwnxjMMKrwP12DBwCSw8c5lI9cnwAAAABJRU5ErkJggg==";

      await generateText({
        model: aiService.getVLMClient(),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image? Reply in one word." },
              { type: "image", image: Buffer.from(minimalPng, "base64") },
            ],
          },
        ],
      });

      logger.debug("Vision validation successful");
      return { success: true };
    } catch (error) {
      const errorCode = this.mapErrorToCode(error, true);
      logger.warn({ error, errorCode }, "Vision validation failed");
      return { success: false, error: errorCode };
    }
  }

  /**
   * Validate embedding capability
   */
  private async validateEmbedding(aiService: AISDKService): Promise<CapabilityValidationResult> {
    logger.debug("Validating embedding capability");

    try {
      await embed({
        model: aiService.getEmbeddingClient(),
        value: "test",
      });

      logger.debug("Embedding validation successful");
      return { success: true };
    } catch (error) {
      const errorCode = this.mapErrorToCode(error, false, true);
      logger.warn({ error, errorCode }, "Embedding validation failed");
      return { success: false, error: errorCode };
    }
  }

  /**
   * Map error to validation error code
   * @param error - The error to map
   * @param isVisionValidation - Whether this is a vision validation error
   * @param isEmbeddingValidation - Whether this is an embedding validation error
   */
  private mapErrorToCode(
    error: unknown,
    isVisionValidation = false,
    isEmbeddingValidation = false
  ): string {
    if (!(error instanceof Error)) {
      return LLMValidationErrorCode.UNKNOWN;
    }

    const message = error.message.toLowerCase();
    const errorName = error.name?.toLowerCase() || "";

    // Check for network errors
    if (
      message.includes("network") ||
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      errorName.includes("fetch")
    ) {
      return LLMValidationErrorCode.NETWORK_ERROR;
    }

    // Check for timeout
    if (message.includes("timeout") || message.includes("timed out")) {
      return LLMValidationErrorCode.TIMEOUT;
    }

    // Check for 404 errors
    if (message.includes("404") || message.includes("not found")) {
      return LLMValidationErrorCode.NOT_FOUND_404;
    }

    // Check for 401 unauthorized
    if (
      message.includes("401") ||
      message.includes("unauthorized") ||
      message.includes("invalid api key") ||
      message.includes("incorrect api key")
    ) {
      return LLMValidationErrorCode.UNAUTHORIZED_401;
    }

    // Check for vision not supported
    if (isVisionValidation) {
      if (
        message.includes("image") ||
        message.includes("vision") ||
        message.includes("does not support") ||
        message.includes("unsupported")
      ) {
        return LLMValidationErrorCode.VISION_NOT_SUPPORTED;
      }
    }

    // Check for embedding not supported
    if (isEmbeddingValidation) {
      if (
        message.includes("embedding") ||
        message.includes("does not support") ||
        message.includes("unsupported")
      ) {
        return LLMValidationErrorCode.EMBEDDING_NOT_SUPPORTED;
      }
    }

    // Check for invalid response
    if (message.includes("invalid") || message.includes("parse") || message.includes("json")) {
      return LLMValidationErrorCode.INVALID_RESPONSE;
    }

    return LLMValidationErrorCode.UNKNOWN;
  }
}

// Export singleton instance getter
export const llmConfigService = LLMConfigService.getInstance();
