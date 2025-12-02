// import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
/**
 * AI SDK Module Configuration
 */
export interface AISDKConfig {
  apiKey: string;
  baseURL: string;
  model?: string;
  name: string;
}

/**
 * AI SDK Module Error
 */
export class AISDKError extends Error {
  constructor(
    public code: "API_KEY_MISSING" | "NOT_INITIALIZED" | "INITIALIZATION_ERROR",
    message: string
  ) {
    super(message);
    this.name = "AISDKError";
  }
}

// Module state
let client: OpenAICompatibleProvider | null = null;
let initialized = false;
let currentModel = "gpt-4o";

/**
 * Initialize the AI SDK with the provided configuration
 * @param config - Configuration object with API key and optional settings
 * @throws AISDKError if API key is missing or empty
 */
export function initialize(config: AISDKConfig): void {
  // Get API key from config or environment
  const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    initialized = false;
    client = null;
    throw new AISDKError("API_KEY_MISSING", "请配置 OpenAI API Key");
  }

  try {
    client = createOpenAICompatible(config);
    initialized = true;
  } catch (error) {
    initialized = false;
    client = null;
    throw new AISDKError(
      "INITIALIZATION_ERROR",
      `AI SDK 初始化失败: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Check if the AI SDK is initialized
 * @returns true if initialized, false otherwise
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Get the language model instance with the current model
 * @returns The language model instance ready to use
 * @throws AISDKError if not initialized
 */
export function getClient(): LanguageModel {
  if (!initialized || !client) {
    throw new AISDKError("NOT_INITIALIZED", "AI SDK 未初始化");
  }
  return client(currentModel);
}

/**
 * Get the current model name
 * @returns The current model name
 */
export function getModel(): string {
  return currentModel;
}
