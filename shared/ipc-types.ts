import { ErrorCode, ServiceError } from "./errors";

/**
 * IPC Error Structure
 */
export interface IPCError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Generic IPC Result Wrapper
 */
export interface IPCResult<T> {
  success: boolean;
  data?: T;
  error?: IPCError;
}

/**
 * IPC Channel Definitions
 */
export const IPC_CHANNELS = {
  VLM_ANALYZE: "vlm:analyze",
  VLM_STATUS: "vlm:status",
  // i18n channels
  I18N_CHANGE_LANGUAGE: "i18n:change-language",
  I18N_GET_LANGUAGE: "i18n:get-language",
  I18N_GET_SYSTEM_LANGUAGE: "i18n:get-system-language",
  // LLM Configuration channels
  LLM_CONFIG_CHECK: "llm:config:check",
  LLM_CONFIG_VALIDATE: "llm:config:validate",
  LLM_CONFIG_SAVE: "llm:config:save",
  LLM_CONFIG_GET: "llm:config:get",
} as const;

/**
 * i18n IPC Payload Types
 */
export interface LanguageChangePayload {
  language: "en" | "zh-CN";
}

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * Convert Error to IPCError
 */
export function toIPCError(error: unknown): IPCError {
  if (error instanceof ServiceError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: ErrorCode.UNKNOWN,
      message: error.message,
      details: error.stack,
    };
  }

  return {
    code: ErrorCode.UNKNOWN,
    message: String(error),
  };
}
