import { SupportedLanguage } from "./i18n-types";

export type LLMConfigMode = "unified" | "separate";

export interface LLMEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface UnifiedLLMConfig {
  mode: "unified";
  config: LLMEndpointConfig;
  language?: SupportedLanguage;
}

export interface SeparateLLMConfig {
  mode: "separate";
  vlm: LLMEndpointConfig;
  textLlm: LLMEndpointConfig;
  embeddingLlm: LLMEndpointConfig;
  language?: SupportedLanguage;
}

export type LLMConfig = UnifiedLLMConfig | SeparateLLMConfig;

export interface CapabilityValidationResult {
  success: boolean;
  error?: string;
}

export interface LLMValidationResult {
  success: boolean;
  textCompletion?: CapabilityValidationResult;
  vision?: CapabilityValidationResult;
  embedding?: CapabilityValidationResult;
}

export interface LLMConfigCheckResult {
  configured: boolean;
  config?: LLMConfig;
}

export enum LLMValidationErrorCode {
  NETWORK_ERROR = "NETWORK_ERROR",
  NOT_FOUND_404 = "NOT_FOUND_404",
  UNAUTHORIZED_401 = "UNAUTHORIZED_401",
  INVALID_API_KEY = "INVALID_API_KEY",
  VISION_NOT_SUPPORTED = "VISION_NOT_SUPPORTED",
  EMBEDDING_NOT_SUPPORTED = "EMBEDDING_NOT_SUPPORTED",
  INVALID_RESPONSE = "INVALID_RESPONSE",
  TIMEOUT = "TIMEOUT",
  UNKNOWN = "UNKNOWN",
}
