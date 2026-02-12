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
  SCREEN_CAPTURE_STATE_CHANGED: "screen-capture:state-changed",
  SCREEN_CAPTURE_UPDATE_CONFIG: "screen-capture:update-config",
  // Permission channels
  PERMISSION_CHECK: "permission:check",
  PERMISSION_REQUEST_SCREEN_RECORDING: "permission:request-screen-recording",
  PERMISSION_REQUEST_ACCESSIBILITY: "permission:request-accessibility",
  PERMISSION_OPEN_SCREEN_RECORDING_SETTINGS: "permission:open-screen-recording-settings",
  PERMISSION_OPEN_ACCESSIBILITY_SETTINGS: "permission:open-accessibility-settings",
  PERMISSION_STATUS_CHANGED: "permission:status-changed",
  // Capture Source Settings channels
  CAPTURE_SOURCES_INIT_SERVICES: "capture-sources:init-services",
  CAPTURE_SOURCES_GET_SCREENS: "capture-sources:get-screens",
  CAPTURE_SOURCES_GET_APPS: "capture-sources:get-apps",
  CAPTURE_SOURCES_GET_PREFERENCES: "capture-sources:get-preferences",
  CAPTURE_SOURCES_SET_PREFERENCES: "capture-sources:set-preferences",
  // User Settings channels
  USER_SETTINGS_GET: "user-settings:get",
  USER_SETTINGS_UPDATE: "user-settings:update",
  USER_SETTINGS_SET_CAPTURE_OVERRIDE: "user-settings:set-capture-override",
  USER_SETTINGS_SET_ONBOARDING_PROGRESS: "user-settings:set-onboarding-progress",
  // Threads / Active Thread Lens channels
  THREADS_GET_ACTIVE_STATE: "threads:get-active-state",
  THREADS_GET_ACTIVE_CANDIDATES: "threads:get-active-candidates",
  THREADS_GET_RESOLVED_ACTIVE: "threads:get-resolved-active",
  THREADS_PIN: "threads:pin",
  THREADS_UNPIN: "threads:unpin",
  THREADS_GET: "threads:get",
  THREADS_LIST: "threads:list",
  THREADS_GET_BRIEF: "threads:get-brief",
  THREADS_MARK_INACTIVE: "threads:mark-inactive",
  THREADS_GET_LENS_STATE: "threads:get-lens-state",
  THREADS_LENS_STATE_CHANGED: "threads:lens-state-changed",
  THREADS_BRIEF_UPDATED: "threads:brief-updated",
  // Context Graph channels
  CONTEXT_SEARCH: "context:search",
  CONTEXT_SEARCH_CANCEL: "context:search:cancel",
  CONTEXT_GET_THREAD: "context:get-thread",
  CONTEXT_GET_EVIDENCE: "context:get-evidence",
  // Usage channels
  USAGE_GET_SUMMARY: "usage:get-summary",
  USAGE_GET_DAILY: "usage:get-daily", // For heatmap/daily chart
  USAGE_GET_BREAKDOWN: "usage:get-breakdown", // By model/capability
  // App navigation
  APP_NAVIGATE: "app:navigate",
  // Activity Monitor channels
  ACTIVITY_GET_TIMELINE: "activity:get-timeline",
  ACTIVITY_GET_SUMMARY: "activity:get-summary",
  ACTIVITY_GET_EVENT_DETAILS: "activity:get-event-details",
  ACTIVITY_REGENERATE_SUMMARY: "activity:regenerate-summary",
  ACTIVITY_TIMELINE_CHANGED: "activity:timeline-changed",
  // AI Failure Circuit Breaker
  AI_FAILURE_FUSE_TRIPPED: "ai:fuse-tripped",
  MONITORING_OPEN_DASHBOARD: "monitoring:open-dashboard",
  // Notifications
  NOTIFICATION_SHOW: "notification:show",
  NOTIFICATION_GET_PREFERENCES: "notification:get-preferences",
  NOTIFICATION_UPDATE_PREFERENCES: "notification:update-preferences",
  NOTIFICATION_ON_CLICK: "notification:on-click",
  NOTIFICATION_TOAST: "notification:toast",
  // App channels
  APP_UPDATE_TITLE_BAR: "app:update-title-bar",
  APP_UPDATE_GET_STATUS: "app-update:get-status",
  APP_UPDATE_CHECK_NOW: "app-update:check-now",
  APP_UPDATE_RESTART_AND_INSTALL: "app-update:restart-and-install",
  APP_UPDATE_OPEN_DOWNLOAD_PAGE: "app-update:open-download-page",
  APP_UPDATE_STATUS_CHANGED: "app-update:status-changed",
  // Screen Capture Real-time events
  SCREEN_CAPTURE_CAPTURING_STARTED: "screen-capture:capturing-started",
  SCREEN_CAPTURE_CAPTURING_FINISHED: "screen-capture:capturing-finished",
  // Boot status channels
  BOOT_GET_STATUS: "boot:get-status",
  BOOT_STATUS_CHANGED: "boot:status-changed",
  BOOT_RETRY_FTS_REPAIR: "boot:retry-fts-repair",
  BOOT_FTS_HEALTH_CHANGED: "boot:fts-health-changed",
} as const;

/**
 * AI Failure Circuit Breaker Payload
 */
export interface AIFailureFuseTrippedPayload {
  windowMs: number;
  threshold: number;
  count: number;
  last: { capability: "vlm" | "text" | "embedding"; message: string };
}

/**
 * Usage IPC Types
 */
export interface UsageTimeRangePayload {
  fromTs: number;
  toTs: number;
  configHash?: string;
}

export interface UsageSummaryResult {
  totalTokens: number;
  requestCount: number;
  succeededCount: number;
  failedCount: number;
}

export interface UsageBreakdownItem {
  model: string;
  capability: string;
  requestCount: number;
  totalTokens: number;
  succeededCount: number;
}

export interface UsageDailyItem {
  date: string;
  totalTokens: number;
}

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

export interface MonitoringOpenDashboardResult {
  url: string;
}

/**
 * App Title Bar Payload
 */
export interface AppUpdateTitleBarPayload {
  backgroundColor: string;
  symbolColor: string;
}

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * Boot Status Types
 */
export type BootPhase =
  | "db-init"
  | "fts-check"
  | "fts-rebuild"
  | "app-init"
  | "background-init"
  | "ready"
  | "degraded"
  | "failed";

export type BootMessageKey =
  | "boot.phase.dbInit"
  | "boot.phase.ftsCheck"
  | "boot.phase.ftsRebuild"
  | "boot.phase.appInit"
  | "boot.phase.backgroundInit"
  | "boot.phase.ready"
  | "boot.phase.degraded"
  | "boot.phase.failed";

export interface BootStatus {
  phase: BootPhase;
  progress: number;
  messageKey: BootMessageKey;
  errorCode?: string;
  errorMessage?: string;
  timestamp: number;
}

export type FtsHealthStatus = "healthy" | "rebuilding" | "degraded" | "unknown";

export interface FtsStartupResult {
  status: FtsHealthStatus;
  durationMs: number;
  checkAttempts: number;
  rebuildPerformed: boolean;
  error?: string;
  errorCode?: string;
}

export interface FtsHealthDetails {
  status: FtsHealthStatus;
  lastCheckAt: number | null;
  lastRebuildAt: number | null;
  rebuildAttempts: number;
  isUsable: boolean;
}

/**
 * Boot Status IPC Types
 */
export type BootGetStatusResult = IPCResult<BootStatus>;
export type BootStatusChangedPayload = BootStatus;
export type BootRetryFtsRepairResult = IPCResult<{ success: boolean; error?: string }>;
export type BootFtsHealthChangedPayload = FtsHealthDetails;

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
