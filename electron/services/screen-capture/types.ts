import type { NativeImage } from "electron";

// ============================================================================
// Scheduler Types
// ============================================================================

/**
 * Configuration for the screen capture scheduler
 */
export interface SchedulerConfig {
  /** Capture interval in milliseconds (default: 15000) */
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
  appIcon?: NativeImage;
  /** Physical bounds for multi-monitor stitching */
  bounds?: { x: number; y: number; width: number; height: number };
  /** Application name (from AppleScript on macOS, e.g., "Google Chrome" for browser windows) */
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
  /** Whether to stitch multi-monitor captures */
  stitchMultiMonitor: boolean;
}

/**
 * Result of a capture operation
 */
export interface CaptureResult {
  /** Image buffer */
  buffer: Buffer;
  /** Image dimensions */
  width: number;
  height: number;
  /** Capture timestamp */
  timestamp: number;
  /** Source information */
  sources: CaptureSource[];
  /** Whether this is a stitched multi-monitor image */
  isComposite: boolean;
}

/**
 * Information about a monitor
 */
export interface MonitorInfo {
  id: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  isPrimary: boolean;
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
  | "scheduler:state";

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
  result: CaptureResult;
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
 * Union type for all scheduler event payloads
 */
export type SchedulerEventPayload =
  | CaptureStartEvent
  | CaptureCompleteEvent
  | CaptureErrorEvent
  | SchedulerStateEvent;

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
}

// ============================================================================
// Default Configurations
// ============================================================================

/**
 * Default scheduler configuration
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  interval: 6000, // 6 seconds
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
  stitchMultiMonitor: true,
};

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
  ],
  appAliases: {
    "Microsoft Teams": ["msteams", "teams"],
    WeChat: ["wechat", "weixin"],
    "Google Chrome": ["chrome"],
    "Visual Studio Code": ["code", "vscode"],
    "Microsoft PowerPoint": ["powerpoint"],
    "Microsoft Word": ["word"],
    "Microsoft Excel": ["excel"],
  },
};
