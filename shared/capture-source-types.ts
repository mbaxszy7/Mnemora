/**
 * Capture Source Settings Types
 *
 * This module defines the data types for the capture source settings feature,
 * including screen information, application information, and user preferences.
 */

import { CaptureSource } from "electron/services/screen-capture/types";

/**
 * Screen information with thumbnail for visual selection
 */
export type ScreenInfo = Omit<CaptureSource, "appIcon"> & {
  bounds: { x: number; y: number; width: number; height: number };
  displayId: string;
  type: "screen";
  isPrimary: boolean;
  thumbnail: string;
};

/**
 * Application information for selection
 * Note: icon and isPopular are computed on the frontend using findPopularApp
 */
export type AppInfo = Omit<CaptureSource, "displayId" | "bounds"> & {
  appIcon: string;
  type: "window";
};

/**
 * User preferences for capture sources (session-level only)
 */
export interface CapturePreferences {
  /** Selected screen information */
  selectedScreens: ScreenInfo[];
  /** Selected application information */
  selectedApps: AppInfo[];
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
