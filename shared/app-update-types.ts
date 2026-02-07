export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export type AppUpdatePlatformAction = "restart-and-install" | "open-download-page" | "none";
export type AppUpdateChannel = "stable" | "nightly";

export interface AppUpdateStatus {
  channel: AppUpdateChannel;
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseUrl: string | null;
  platformAction: AppUpdatePlatformAction;
  message: string | null;
  lastCheckedAt: number | null;
  updatedAt: number;
}

export interface CheckNowResult {
  started: boolean;
}
