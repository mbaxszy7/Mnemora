export type CaptureManualOverride = "none" | "force_on" | "force_off";

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
