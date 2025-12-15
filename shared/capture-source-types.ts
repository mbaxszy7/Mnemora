import { CaptureSource } from "electron/services/screen-capture/types";

export type ScreenInfo = Omit<CaptureSource, "appIcon"> & {
  bounds: { x: number; y: number; width: number; height: number };
  displayId: string;
  type: "screen";
  isPrimary: boolean;
  thumbnail: string;
};

export type AppInfo = Omit<CaptureSource, "displayId" | "bounds"> & {
  appIcon: string;
  type: "window";
};

export interface CapturePreferences {
  /** Selected screen information */
  selectedScreens: ScreenInfo[];
  /** Selected application information */
  selectedApps: AppInfo[];
}

export interface GetScreensResponse {
  /** List of available screens with thumbnails */
  screens: ScreenInfo[];
}

export interface GetAppsResponse {
  /** List of available applications with icons */
  apps: AppInfo[];
}

export interface SetPreferencesRequest {
  /** Partial preferences to update */
  preferences: Partial<CapturePreferences>;
}

export interface PreferencesResponse {
  /** Current capture preferences */
  preferences: CapturePreferences;
}
