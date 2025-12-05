/**
 * LLM Configuration Types
 * Types for managing LLM API configuration in unified or separate mode
 */

/**
 * Configuration mode - unified uses single config for all tasks,
 * separate uses distinct configs for VLM, Text LLM, and Embedding
 */
export type LLMConfigMode = "unified" | "separate";

/**
 * Single LLM endpoint configuration
 */
export interface LLMEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Unified mode configuration - single endpoint for all capabilities
 */
export interface UnifiedLLMConfig {
  mode: "unified";
  config: LLMEndpointConfig;
}

/**
 * Separate mode configuration - distinct endpoints for each capability
 */
export interface SeparateLLMConfig {
  mode: "separate";
  vlm: LLMEndpointConfig;
  textLlm: LLMEndpointConfig;
  embeddingLlm: LLMEndpointConfig;
}

/**
 * Combined LLM configuration type
 */
export type LLMConfig = UnifiedLLMConfig | SeparateLLMConfig;

/**
 * Individual capability validation result
 */
export interface CapabilityValidationResult {
  success: boolean;
  error?: string;
}

/**
 * Complete validation result for all capabilities
 */
export interface LLMValidationResult {
  success: boolean;
  textCompletion?: CapabilityValidationResult;
  vision?: CapabilityValidationResult;
  embedding?: CapabilityValidationResult;
}

/**
 * Configuration check result - used on startup
 */
export interface LLMConfigCheckResult {
  configured: boolean;
  config?: LLMConfig;
}

/**
 * Validation error codes for specific failure types
 */
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
