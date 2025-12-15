import { LLMEndpointConfig, LLMValidationErrorCode, SeparateLLMConfig } from "./llm-config-types";

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

export function isEndpointConfigComplete(config: LLMEndpointConfig): boolean {
  if (!config) {
    return false;
  }

  const hasValidUrl = isValidUrl(config.baseUrl);
  const hasApiKey = typeof config.apiKey === "string" && config.apiKey.trim().length > 0;
  const hasModel = typeof config.model === "string" && config.model.trim().length > 0;

  return hasValidUrl && hasApiKey && hasModel;
}

export function isSeparateConfigComplete(config: SeparateLLMConfig): boolean {
  return (
    isEndpointConfigComplete(config.vlm) &&
    isEndpointConfigComplete(config.textLlm) &&
    isEndpointConfigComplete(config.embeddingLlm)
  );
}

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

export function getValidationErrorKey(errorCode: LLMValidationErrorCode): string {
  // Validate that the error code is a valid enum value
  const validCodes = Object.values(LLMValidationErrorCode);
  if (!validCodes.includes(errorCode)) {
    return `llmConfig.validation.${LLMValidationErrorCode.UNKNOWN}`;
  }
  return `llmConfig.validation.${errorCode}`;
}
