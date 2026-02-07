export type NotificationType =
  | "activity-summary"
  | "llm-broken"
  | "capture-paused"
  | "app-update-available"
  | "app-update-downloaded";

export type NotificationPriority = "low" | "normal" | "high" | "critical";

export interface NotificationAction {
  id: string;
  label: string;
}

export interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  priority: NotificationPriority;
  data?: Record<string, unknown>;
  toastActions?: NotificationAction[];
  silent?: boolean;
}

export interface NotificationClickPayload {
  notificationId: string;
  notificationType: NotificationType;
  data?: Record<string, unknown>;
}

export interface NotificationToastPayload {
  notification: NotificationPayload;
}

export interface NotificationPreferences {
  enabled: boolean;
  activitySummary: boolean;
  llmErrors: boolean;
  capturePaused: boolean;
  soundEnabled: boolean;
  doNotDisturb: boolean;
  doNotDisturbFrom: string;
  doNotDisturbTo: string;
}

export interface ShowNotificationRequest {
  notification: NotificationPayload;
}

export interface NotificationPreferencesRequest {
  preferences: Partial<NotificationPreferences>;
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
}
