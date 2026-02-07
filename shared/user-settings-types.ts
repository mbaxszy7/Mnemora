export type CaptureManualOverride = "none" | "force_on" | "force_off";
export type OnboardingProgress = "pending_home" | "pending_settings" | "completed" | "skipped";
export const ONBOARDING_PROGRESS_VALUES: readonly OnboardingProgress[] = [
  "pending_home",
  "pending_settings",
  "completed",
  "skipped",
] as const;

export function isOnboardingProgress(value: unknown): value is OnboardingProgress {
  return (
    typeof value === "string" && ONBOARDING_PROGRESS_VALUES.includes(value as OnboardingProgress)
  );
}

export const CONTEXT_RULES_MAX_CHARS = 8000;

export interface CaptureAllowedWindow {
  start: string;
  end: string;
}

export interface UserSettings {
  capturePrimaryScreenOnly: boolean;
  captureScheduleEnabled: boolean;
  captureAllowedWindows: CaptureAllowedWindow[];
  captureManualOverride: CaptureManualOverride;
  captureManualOverrideUpdatedAt: number | null;

  contextRulesEnabled: boolean;
  contextRulesMarkdown: string;
  contextRulesUpdatedAt: number | null;

  onboardingProgress: OnboardingProgress;
  onboardingUpdatedAt: number | null;
}

export interface UserSettingsResponse {
  settings: UserSettings;
}

export interface UpdateUserSettingsRequest {
  settings: Partial<
    Pick<
      UserSettings,
      | "capturePrimaryScreenOnly"
      | "captureScheduleEnabled"
      | "captureAllowedWindows"
      | "contextRulesEnabled"
      | "contextRulesMarkdown"
    >
  >;
}

export interface SetCaptureManualOverrideRequest {
  mode: CaptureManualOverride;
}

export interface SetOnboardingProgressRequest {
  progress: OnboardingProgress;
}
