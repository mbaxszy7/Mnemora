/**
 * Capture Source Settings Types
 *
 * This module defines the data types for the capture source settings feature,
 * including screen information, application information, and user preferences.
 *
 * ⚠️ IMPORTANT: Screen ID Systems
 * ================================
 * There are multiple screen ID systems in use:
 *
 * 1. desktopCapturer ID (Electron) - Format: "screen:INDEX:0"
 *    - Used for getting thumbnails
 *    - INDEX is 0-based, NOT the actual display ID
 *
 * 2. CGDirectDisplayID (macOS) - Format: numeric (e.g., 69732800)
 *    - Used by: Electron screen.getAllDisplays(), node-screenshots Monitor.id
 *    - This is the actual system display identifier
 *
 * When filtering screens for capture, we need to map from desktopCapturer IDs
 * to CGDirectDisplayID for use with node-screenshots.
 *
 * See: electron/ipc/capture-source-settings-handlers.ts for mapping logic
 */

/**
 * Screen information with thumbnail for visual selection
 */
export interface ScreenInfo {
  /**
   * Unique identifier for the screen (desktopCapturer format: "screen:INDEX:0")
   *
   * ⚠️ Note: This ID is from desktopCapturer and uses a different format than
   * node-screenshots. When filtering captures, use displayId instead.
   */
  id: string;
  /** Display name of the screen */
  name: string;
  /** Base64 encoded thumbnail image */
  thumbnail: string;
  /** Screen width in pixels */
  width: number;
  /** Screen height in pixels */
  height: number;
  /** Whether this is the primary display */
  isPrimary: boolean;
  /**
   * The actual display ID (CGDirectDisplayID on macOS)
   * This matches node-screenshots Monitor.id and should be used for filtering captures.
   */
  displayId: string;
}

/**
 * Application information for selection
 * Note: icon and isPopular are computed on the frontend using findPopularApp
 */
export interface AppInfo {
  /** Application name */
  name: string;
  /** Number of windows this app currently has open */
  windowCount: number;
}

/**
 * User preferences for capture sources (session-level only)
 */
export interface CapturePreferences {
  /** Selected screen IDs (empty array means all screens) */
  selectedScreenIds: string[];
  /** Selected application names (empty array means all apps) */
  selectedAppNames: string[];
}

/**
 * Response type for getting screens list
 */
export interface GetScreensResponse {
  /** List of available screens with thumbnails */
  screens: ScreenInfo[];
}

/**
 * Response type for getting applications list
 */
export interface GetAppsResponse {
  /** List of available applications with icons */
  apps: AppInfo[];
}

/**
 * Request type for setting preferences
 */
export interface SetPreferencesRequest {
  /** Partial preferences to update */
  preferences: Partial<CapturePreferences>;
}

/**
 * Response type for preferences operations (get/set)
 */
export interface PreferencesResponse {
  /** Current capture preferences */
  preferences: CapturePreferences;
}
