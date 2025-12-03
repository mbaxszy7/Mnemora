import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { ServiceError, ErrorCode } from "@shared/errors";

/**
 * AI SDK Service Configuration
 */
export interface AISDKConfig {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * AISDKService - Singleton class for managing AI SDK client
 *
 * Provides a centralized, type-safe way to initialize and access the AI SDK client.
 * Uses the singleton pattern to ensure only one instance exists throughout the application.
 */
export class AISDKService {
  private static instance: AISDKService | null = null;

  private client: OpenAICompatibleProvider | null = null;
  private config: AISDKConfig | null = null;
  private _initialized = false;

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {}

  /**
   * Get the singleton instance of AISDKService
   * @returns The singleton AISDKService instance
   */
  static getInstance(): AISDKService {
    if (!AISDKService.instance) {
      AISDKService.instance = new AISDKService();
    }
    return AISDKService.instance;
  }

  /**
   * Reset the singleton instance (for testing purposes only)
   */
  static resetInstance(): void {
    AISDKService.instance = null;
  }

  /**
   * Initialize the AI SDK with the provided configuration
   * @param config - Configuration object with API key and settings
   * @throws ServiceError with API_KEY_MISSING if API key is empty
   * @throws ServiceError with INITIALIZATION_ERROR if initialization fails
   */
  initialize(config: AISDKConfig): void {
    if (!config.apiKey || config.apiKey.trim() === "") {
      this._initialized = false;
      this.client = null;
      throw new ServiceError(ErrorCode.API_KEY_MISSING, "请配置 API Key");
    }

    try {
      this.client = createOpenAICompatible({
        name: config.name,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
      });
      this.config = config;
      this._initialized = true;
    } catch (error) {
      this._initialized = false;
      this.client = null;
      throw new ServiceError(
        ErrorCode.INITIALIZATION_ERROR,
        `AI SDK 初始化失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if the AI SDK is initialized
   * @returns true if initialized, false otherwise
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Get the language model client
   * @returns The language model instance
   * @throws ServiceError with NOT_INITIALIZED if not initialized
   */
  getClient(): LanguageModel {
    if (!this._initialized || !this.client || !this.config) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "AI SDK 未初始化");
    }
    return this.client(this.config.model);
  }

  /**
   * Get the current model name
   * @returns The model name or default value
   */
  getModel(): string {
    if (!this.config) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "AI SDK 未初始化");
    }
    return this.config.model;
  }
}
