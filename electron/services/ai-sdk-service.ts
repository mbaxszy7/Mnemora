import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { LanguageModel, EmbeddingModel } from "ai";
import { ServiceError, ErrorCode } from "@shared/errors";
import type { LLMConfig, LLMEndpointConfig } from "@shared/llm-config-types";

/**
 * Internal client state for each client type
 */
interface ClientState {
  provider: OpenAICompatibleProvider;
  model: string;
}

/**
 * AISDKService - Unified AI client management
 * Provides vlmClient, textClient, and embeddingClient
 */
export class AISDKService {
  private static instance: AISDKService | null = null;

  private vlmClient: ClientState | null = null;
  private textClient: ClientState | null = null;
  private embeddingClient: ClientState | null = null;
  private _initialized = false;

  private constructor() {}

  static getInstance(): AISDKService {
    if (!AISDKService.instance) {
      AISDKService.instance = new AISDKService();
    }
    return AISDKService.instance;
  }

  static resetInstance(): void {
    AISDKService.instance = null;
  }

  /**
   * Initialize from LLMConfig (unified or separate mode)
   * This is the primary initialization method
   */
  initialize(config: LLMConfig): void {
    this.reset();

    try {
      if (config.mode === "unified") {
        // Unified mode - same config for all clients
        const state = this.createClientState(config.config);
        this.vlmClient = state;
        this.textClient = state;
        this.embeddingClient = state;
      } else {
        // Separate mode - distinct configs
        this.vlmClient = this.createClientState(config.vlm);
        this.textClient = this.createClientState(config.textLlm);
        this.embeddingClient = this.createClientState(config.embeddingLlm);
      }

      this._initialized = true;
    } catch (error) {
      this.reset();
      if (error instanceof ServiceError) {
        throw error;
      }
      throw new ServiceError(
        ErrorCode.INITIALIZATION_ERROR,
        `AI SDK initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Reset all clients
   */
  private reset(): void {
    this.vlmClient = null;
    this.textClient = null;
    this.embeddingClient = null;
    this._initialized = false;
  }

  /**
   * Create client state from endpoint config
   */
  private createClientState(endpoint: LLMEndpointConfig): ClientState {
    this.validateEndpoint(endpoint);
    const provider = createOpenAICompatible({
      name: "mnemora",
      baseURL: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      headers: {
        authorization: `Bearer ${endpoint.apiKey}`,
      },
    });
    return { provider, model: endpoint.model };
  }

  /**
   * Validate endpoint configuration
   */
  private validateEndpoint(endpoint: LLMEndpointConfig): void {
    if (!endpoint.apiKey?.trim()) {
      throw new ServiceError(ErrorCode.API_KEY_MISSING, "API Key is required");
    }
    if (!endpoint.baseUrl?.trim()) {
      throw new ServiceError(ErrorCode.INITIALIZATION_ERROR, "Base URL is required");
    }
    if (!endpoint.model?.trim()) {
      throw new ServiceError(ErrorCode.INITIALIZATION_ERROR, "Model is required");
    }
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Get VLM (Vision Language Model) client
   */
  getVLMClient(): LanguageModel {
    if (!this._initialized || !this.vlmClient) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "VLM client not initialized");
    }
    return this.vlmClient.provider(this.vlmClient.model);
  }

  /**
   * Get Text LLM client
   */
  getTextClient(): LanguageModel {
    if (!this._initialized || !this.textClient) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "Text LLM client not initialized");
    }
    return this.textClient.provider(this.textClient.model);
  }

  /**
   * Get Embedding client
   */
  getEmbeddingClient(): EmbeddingModel<string> {
    if (!this._initialized || !this.embeddingClient) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "Embedding client not initialized");
    }
    return this.embeddingClient.provider.textEmbeddingModel(this.embeddingClient.model);
  }

  /**
   * Get VLM Model Name
   */
  getVLMModelName(): string {
    if (!this._initialized || !this.vlmClient) {
      return "unknown";
    }
    return this.vlmClient.model;
  }

  /**
   * Get Text LLM Model Name
   */
  getTextModelName(): string {
    if (!this._initialized || !this.textClient) {
      return "unknown";
    }
    return this.textClient.model;
  }

  /**
   * Get Embedding Model Name
   */
  getEmbeddingModelName(): string {
    if (!this._initialized || !this.embeddingClient) {
      return "unknown";
    }
    return this.embeddingClient.model;
  }
}
