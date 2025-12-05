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
  // Database channels
  DB_SETTINGS_GET: "db:settings:get",
  DB_SETTINGS_SET: "db:settings:set",
  DB_SETTINGS_GET_ALL: "db:settings:getAll",
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
