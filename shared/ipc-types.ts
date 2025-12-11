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
  // Screen Capture Scheduler channels
  SCREEN_CAPTURE_START: "screen-capture:start",
  SCREEN_CAPTURE_STOP: "screen-capture:stop",
  SCREEN_CAPTURE_PAUSE: "screen-capture:pause",
  SCREEN_CAPTURE_RESUME: "screen-capture:resume",
  SCREEN_CAPTURE_GET_STATE: "screen-capture:get-state",
  SCREEN_CAPTURE_UPDATE_CONFIG: "screen-capture:update-config",
  // Permission channels
  PERMISSION_CHECK: "permission:check",
  PERMISSION_REQUEST_SCREEN_RECORDING: "permission:request-screen-recording",
  PERMISSION_REQUEST_ACCESSIBILITY: "permission:request-accessibility",
  PERMISSION_OPEN_SCREEN_RECORDING_SETTINGS: "permission:open-screen-recording-settings",
  PERMISSION_OPEN_ACCESSIBILITY_SETTINGS: "permission:open-accessibility-settings",
  PERMISSION_INIT_SERVICES: "permission:init-services",
} as const;

/**
 * i18n IPC Payload Types
 */
export interface LanguageChangePayload {
  language: "en" | "zh-CN";
}

/**
 * Screen Capture Scheduler IPC Payload Types
 */
export interface SchedulerConfigPayload {
  /** Capture interval in milliseconds */
  interval?: number;
  /** Minimum delay between captures */
  minDelay?: number;
}

export interface SchedulerStatePayload {
  status: "idle" | "running" | "paused" | "stopped";
  lastCaptureTime: number | null;
  nextCaptureTime: number | null;
  captureCount: number;
  errorCount: number;
}

/**
 * Permission IPC Payload Types
 */
export type PermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

export interface PermissionCheckResult {
  screenRecording: PermissionStatus;
  accessibility: PermissionStatus;
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
