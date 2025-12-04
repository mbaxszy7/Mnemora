import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { ServiceError, ErrorCode } from "@shared/errors";

export interface AISDKConfig {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

export class AISDKService {
  private static instance: AISDKService | null = null;

  private client: OpenAICompatibleProvider | null = null;
  private config: AISDKConfig | null = null;
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

  initialize(config: AISDKConfig): void {
    if (!config.apiKey || config.apiKey.trim() === "") {
      this._initialized = false;
      this.client = null;
      throw new ServiceError(ErrorCode.API_KEY_MISSING, "Please configure API Key");
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
        `AI SDK initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  getClient(): LanguageModel {
    if (!this._initialized || !this.client || !this.config) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "AI SDK not initialized");
    }
    return this.client(this.config.model);
  }

  getModel(): string {
    if (!this.config) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "AI SDK not initialized");
    }
    return this.config.model;
  }
}
