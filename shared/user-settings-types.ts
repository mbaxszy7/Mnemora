export type CaptureManualOverride = "none" | "force_on" | "force_off";

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
}

export interface UserSettingsResponse {
  settings: UserSettings;
}

export interface UpdateUserSettingsRequest {
  settings: Partial<
    Pick<
      UserSettings,
      "capturePrimaryScreenOnly" | "captureScheduleEnabled" | "captureAllowedWindows"
    >
  >;
}

export interface SetCaptureManualOverrideRequest {
  mode: CaptureManualOverride;
}
