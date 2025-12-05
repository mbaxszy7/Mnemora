/**
 * LLM Configuration Validation Utilities
 * Utility functions for validating and processing LLM configurations
 */

import { LLMEndpointConfig, LLMValidationErrorCode, SeparateLLMConfig } from "./llm-config-types";

/**
 * Validates if a string is a valid HTTP or HTTPS URL
 *
 * @param url - The URL string to validate
 * @returns true if the URL is valid HTTP/HTTPS format, false otherwise
 *
 * @example
 * isValidUrl("https://api.openai.com") // returns true
 * isValidUrl("http://localhost:8080") // returns true
 * isValidUrl("ftp://example.com") // returns false
 * isValidUrl("not-a-url") // returns false
 */
export function isValidUrl(url: string): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks if an LLM endpoint configuration is complete
 * A complete configuration has non-empty baseUrl (valid URL), apiKey, and model
 *
 * @param config - The endpoint configuration to check
 * @returns true if all required fields are present and valid
 *
 * @example
 * isEndpointConfigComplete({ baseUrl: "https://api.openai.com", apiKey: "sk-xxx", model: "gpt-4" }) // true
 * isEndpointConfigComplete({ baseUrl: "", apiKey: "sk-xxx", model: "gpt-4" }) // false
 */
export function isEndpointConfigComplete(config: LLMEndpointConfig): boolean {
  if (!config) {
    return false;
  }

  const hasValidUrl = isValidUrl(config.baseUrl);
  const hasApiKey = typeof config.apiKey === "string" && config.apiKey.trim().length > 0;
  const hasModel = typeof config.model === "string" && config.model.trim().length > 0;

  return hasValidUrl && hasApiKey && hasModel;
}

/**
 * Checks if a separate mode configuration is complete
 * All three endpoint configurations (vlm, textLlm, embeddingLlm) must be complete
 *
 * @param config - The separate mode configuration to check
 * @returns true if all three configurations are complete
 */
export function isSeparateConfigComplete(config: SeparateLLMConfig): boolean {
  return (
    isEndpointConfigComplete(config.vlm) &&
    isEndpointConfigComplete(config.textLlm) &&
    isEndpointConfigComplete(config.embeddingLlm)
  );
}

/**
 * Encodes an API key using base64 for basic obfuscation
 * Note: This is NOT encryption, just obfuscation for storage
 *
 * @param apiKey - The plain text API key
 * @returns Base64 encoded string
 *
 * @example
 * encodeApiKey("sk-xxx") // returns "c2steHh4"
 */
export function encodeApiKey(apiKey: string): string {
  if (!apiKey || typeof apiKey !== "string") {
    return "";
  }
  // Use Buffer in Node.js environment, btoa in browser
  if (typeof Buffer !== "undefined") {
    return Buffer.from(apiKey, "utf-8").toString("base64");
  }
  return btoa(apiKey);
}

/**
 * Decodes a base64 encoded API key
 *
 * @param encoded - The base64 encoded API key
 * @returns The decoded plain text API key
 *
 * @example
 * decodeApiKey("c2steHh4") // returns "sk-xxx"
 */
export function decodeApiKey(encoded: string): string {
  if (!encoded || typeof encoded !== "string") {
    return "";
  }
  try {
    // Use Buffer in Node.js environment, atob in browser
    if (typeof Buffer !== "undefined") {
      return Buffer.from(encoded, "base64").toString("utf-8");
    }
    return atob(encoded);
  } catch {
    return "";
  }
}

/**
 * Gets the i18n translation key for a validation error code
 *
 * @param errorCode - The validation error code
 * @returns The i18n key for the error message (e.g., "llmConfig.validation.NOT_FOUND_404")
 *
 * @example
 * getValidationErrorKey(LLMValidationErrorCode.NOT_FOUND_404)
 * // returns "llmConfig.validation.NOT_FOUND_404"
 */
export function getValidationErrorKey(errorCode: LLMValidationErrorCode): string {
  // Validate that the error code is a valid enum value
  const validCodes = Object.values(LLMValidationErrorCode);
  if (!validCodes.includes(errorCode)) {
    return `llmConfig.validation.${LLMValidationErrorCode.UNKNOWN}`;
  }
  return `llmConfig.validation.${errorCode}`;
}
