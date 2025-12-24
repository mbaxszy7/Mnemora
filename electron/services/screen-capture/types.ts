import { POPULAR_APPS } from "@shared/popular-apps";

// ============================================================================
// Scheduler Types
// ============================================================================

/**
 * Configuration for the screen capture scheduler
 */
export interface SchedulerConfig {
  /** Capture interval in milliseconds (default: 6000) */
  interval: number;
  /** Minimum delay between captures (default: 100) */
  minDelay: number;
  /** Whether to start immediately (default: false) */
  autoStart: boolean;
}

/**
 * Current state of the scheduler
 */
export interface SchedulerState {
  status: "idle" | "running" | "paused" | "stopped";
  lastCaptureTime: number | null;
  nextCaptureTime: number | null;
  captureCount: number;
  errorCount: number;
}

export interface VisibleSource {
  id: string;
  name: string;
  type: "screen" | "window";
  displayId?: string;
  isVisible: boolean;
}

// ============================================================================
// Capture Source Types
// ============================================================================

/**
 * Represents a screen or window that can be captured
 */
export interface CaptureSource {
  id: string;
  name: string;
  type: "screen" | "window";
  displayId?: string;
  appIcon?: string | null;
  /** Window bounds (used to detect minimized windows with zero/negative dimensions) */
  bounds?: { x: number; y: number; width: number; height: number };
  windowTitle?: string;
  appName?: string;
}

/**
 * Filter options for capture sources
 */
export interface CaptureSourceFilter {
  type?: "screen" | "window" | "all";
  excludeSystemWindows?: boolean;
  excludeMinimized?: boolean;
}

// ============================================================================
// Capture Result Types
// ============================================================================

/**
 * Options for capture operations
 */
export interface CaptureOptions {
  /** Output format */
  format: "jpeg" | "png" | "webp";
  /** Quality for lossy formats (0-100) */
  quality: number;

  selectedScreenIds?: string[];
}

/**
 * Result of a capture operation
 */
export interface CaptureResult {
  /** Image buffer */
  buffer: Buffer;
  /** Capture timestamp */
  timestamp: number;
  /** Optional saved file path after persistence */
  filePath?: string;
  /** Source information (single screen) */
  source: CaptureSource;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * All possible scheduler events
 */
export type SchedulerEvent =
  | "capture:start"
  | "capture:complete"
  | "capture:error"
  | "scheduler:state"
  | "preferences:changed";

/**
 * Event emitted when a capture cycle begins
 */
export interface CaptureStartEvent {
  type: "capture:start";
  timestamp: number;
  captureId: string;
}

/**
 * Event emitted when a capture cycle completes successfully
 */
export interface CaptureCompleteEvent {
  type: "capture:complete";
  timestamp: number;
  captureId: string;
  result: CaptureResult[];
  executionTime: number;
}

/**
 * Event emitted when a capture cycle fails
 */
export interface CaptureErrorEvent {
  type: "capture:error";
  timestamp: number;
  captureId: string;
  error: Error;
}

/**
 * Event emitted when the scheduler state changes
 */
export interface SchedulerStateEvent {
  type: "scheduler:state";
  timestamp: number;
  previousState: SchedulerState["status"];
  currentState: SchedulerState["status"];
}

/**
 * Event emitted when capture preferences change
 */
export interface PreferencesChangedEvent {
  type: "preferences:changed";
  timestamp: number;
}

/**
 * Union type for all scheduler event payloads
 */
export type SchedulerEventPayload =
  | CaptureStartEvent
  | CaptureCompleteEvent
  | CaptureErrorEvent
  | SchedulerStateEvent
  | PreferencesChangedEvent;

/**
 * Event handler type for scheduler events
 */
export type SchedulerEventHandler<T extends SchedulerEventPayload = SchedulerEventPayload> = (
  event: T
) => void;

// ============================================================================
// AutoRefreshCache Types
// ============================================================================

/**
 * Options for AutoRefreshCache
 */
export interface AutoRefreshCacheOptions<T> {
  /** Function to fetch fresh data */
  fetchFn: () => Promise<T>;
  /** Refresh interval in milliseconds (default: 3000) */
  interval: number;
  /** Whether to fetch immediately on creation (default: true) */
  immediate: boolean;
  /** Optional error handler */
  onError?: (error: Error) => void;
}

// ============================================================================
// Window Filter Types
// ============================================================================

/**
 * Configuration for window filtering
 */
export interface WindowFilterConfig {
  /** System window names to exclude */
  systemWindows: string[];
  /** App name aliases for normalization */
  appAliases: Record<string, string[]>;
  /** Important apps that may be prioritized/kept even when minimized/off-space */
  importantApps?: string[];
}

// ============================================================================
// Default Configurations
// ============================================================================

/**
 * Default scheduler configuration
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  interval: 3000, // 6 seconds
  minDelay: 100, // 100ms minimum
  autoStart: false,
};

/**
 * Default cache refresh interval (3 seconds)
 */
export const DEFAULT_CACHE_INTERVAL = 3000;

/**
 * Default capture options
 */
export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  format: "jpeg",
  quality: 80,
};

const POPULAR_APPS_ALIAS = Object.keys(POPULAR_APPS).reduce(
  (acc, key) => {
    acc[key] = POPULAR_APPS[key].aliases;
    return acc;
  },
  {} as Record<string, string[]>
);

const APP_ALIASES: Record<string, string[]> = {
  ...POPULAR_APPS_ALIAS,
  "Microsoft PowerPoint": ["powerpoint"],
  "Microsoft Word": ["word"],
  "Microsoft Excel": ["excel"],
};

const IMPORTANT_APPS = Array.from(
  new Set<string>(
    Object.entries(APP_ALIASES).flatMap(([canonical, aliases]) => [canonical, ...aliases])
  )
);

/**
 * Default window filter configuration
 */
export const DEFAULT_WINDOW_FILTER_CONFIG: WindowFilterConfig = {
  systemWindows: [
    "Dock",
    "Spotlight",
    "Control Center",
    "Notification Center",
    "SystemUIServer",
    "Window Server",
    "Mnemora", // Exclude self
    "Electron", // Exclude self (process name in dev mode)
    "Mnemora - Your Second Brain",
    "ControlCenter",
    "WindowManager",
    "NotificationCenter",
    "AXVisualSupportAgent",
    "universalaccessd",
    "TextInputMenuAgent",
    "CoreLocationAgent",
    "loginwindow",
    "UserNotificationCenter",
    "CursorUIViewService",
    "LinkedNotesUIService",
    "Open and Save Panel Service",
    "程序坞",
    "通知中心",
    "聚焦",
    "墙纸",
    "微信输入法",
    "自动填充",
    "隐私与安全性",
  ],
  appAliases: {
    ...APP_ALIASES,
  },
  // Treat all popular apps (canonical + aliases) as important
  importantApps: IMPORTANT_APPS,
};
