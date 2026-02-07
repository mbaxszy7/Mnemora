import { ipcRenderer, contextBridge } from "electron";
import { IPC_CHANNELS, IPCResult, type MonitoringOpenDashboardResult } from "@shared/ipc-types";
import type { SupportedLanguage } from "@shared/i18n-types";
import type {
  LLMConfig,
  LLMConfigCheckResult,
  LLMValidationResult,
} from "@shared/llm-config-types";
import type {
  GetScreensResponse,
  GetAppsResponse,
  CapturePreferences,
  PreferencesResponse,
} from "@shared/capture-source-types";
import type { PermissionCheckResult } from "@shared/ipc-types";
import type {
  CaptureManualOverride,
  OnboardingProgress,
  SetOnboardingProgressRequest,
  UpdateUserSettingsRequest,
  UserSettingsResponse,
} from "@shared/user-settings-types";
import type {
  SearchQuery,
  SearchResult,
  ExpandedContextNode,
  ScreenshotEvidence,
} from "@shared/context-types";
import type {
  ThreadsGetActiveCandidatesResponse,
  ThreadsGetActiveStateResponse,
  ThreadsGetBriefRequest,
  ThreadsGetBriefResponse,
  ThreadsGetByIdRequest,
  ThreadsGetLensStateResponse,
  ThreadsGetResolvedActiveResponse,
  ThreadsGetResponse,
  ThreadsListRequest,
  ThreadsListResponse,
  ThreadsMarkInactiveRequest,
  ThreadsMarkInactiveResponse,
  ThreadBriefUpdatedPayload,
  ThreadLensStateChangedPayload,
  ThreadsPinRequest,
  ThreadsPinResponse,
  ThreadsUnpinResponse,
} from "@shared/thread-lens-types";
import type { SchedulerStatePayload } from "@shared/ipc-types";
import type {
  TimelineRequest,
  TimelineResponse,
  SummaryRequest,
  SummaryResponse,
  EventDetailsRequest,
  EventDetailsResponse,
  RegenerateSummaryRequest,
  RegenerateSummaryResponse,
  ActivityTimelineChangedPayload,
} from "@shared/activity-types";
import type {
  NotificationClickPayload,
  NotificationPreferencesRequest,
  NotificationPreferencesResponse,
  NotificationToastPayload,
  ShowNotificationRequest,
} from "@shared/notification-types";

export interface I18nApi {
  changeLanguage(lang: SupportedLanguage): Promise<void>;
  getLanguage(): Promise<SupportedLanguage>;
  getSystemLanguage(): Promise<SupportedLanguage>;
}

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args;
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args));
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args;
    return ipcRenderer.off(channel, ...omit);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  },
});
// --------- Expose i18n API to the Renderer process ---------
const i18nApi: I18nApi = {
  async changeLanguage(lang: SupportedLanguage): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.I18N_CHANGE_LANGUAGE, { language: lang });
  },

  async getLanguage(): Promise<SupportedLanguage> {
    const result = (await ipcRenderer.invoke(
      IPC_CHANNELS.I18N_GET_LANGUAGE
    )) as IPCResult<SupportedLanguage>;
    return result.success && result.data ? result.data : "en";
  },

  /**
   * Get the system's detected language
   * @returns System language ('en' or 'zh-CN')
   */
  async getSystemLanguage(): Promise<SupportedLanguage> {
    const result = (await ipcRenderer.invoke(
      IPC_CHANNELS.I18N_GET_SYSTEM_LANGUAGE
    )) as IPCResult<SupportedLanguage>;
    return result.success && result.data ? result.data : "en";
  },
};

contextBridge.exposeInMainWorld("i18nApi", i18nApi);

// --------- Expose LLM Config API to the Renderer process ---------
export interface LLMConfigApi {
  check(): Promise<LLMConfigCheckResult>;
  validate(config: LLMConfig): Promise<LLMValidationResult>;
  save(config: LLMConfig): Promise<void>;
  get(): Promise<LLMConfig | null>;
}

const llmConfigApi: LLMConfigApi = {
  async check(): Promise<LLMConfigCheckResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_CHECK);
  },

  async validate(config: LLMConfig): Promise<LLMValidationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_VALIDATE, config);
  },

  async save(config: LLMConfig): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_SAVE, config);
  },

  async get(): Promise<LLMConfig | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_GET);
  },
};

contextBridge.exposeInMainWorld("llmConfigApi", llmConfigApi);

export interface PermissionApi {
  check(): Promise<IPCResult<PermissionCheckResult>>;
  requestScreenRecording(): Promise<IPCResult<boolean>>;
  requestAccessibility(): Promise<IPCResult<boolean>>;
  openScreenRecordingSettings(): Promise<IPCResult<void>>;
  openAccessibilitySettings(): Promise<IPCResult<void>>;
  onStatusChanged(callback: (payload: PermissionCheckResult) => void): () => void;
}

const permissionApi: PermissionApi = {
  async check(): Promise<IPCResult<PermissionCheckResult>> {
    return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_CHECK);
  },

  async requestScreenRecording(): Promise<IPCResult<boolean>> {
    return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_REQUEST_SCREEN_RECORDING);
  },

  async requestAccessibility(): Promise<IPCResult<boolean>> {
    return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_REQUEST_ACCESSIBILITY);
  },

  async openScreenRecordingSettings(): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_OPEN_SCREEN_RECORDING_SETTINGS);
  },

  async openAccessibilitySettings(): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_OPEN_ACCESSIBILITY_SETTINGS);
  },

  onStatusChanged(callback: (payload: PermissionCheckResult) => void) {
    const subscription = (_event: unknown, payload: PermissionCheckResult) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.PERMISSION_STATUS_CHANGED, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PERMISSION_STATUS_CHANGED, subscription);
    };
  },
};

contextBridge.exposeInMainWorld("permissionApi", permissionApi);

export interface ScreenCaptureApi {
  start(): Promise<IPCResult<void>>;
  stop(): Promise<IPCResult<void>>;
  pause(): Promise<IPCResult<void>>;
  resume(): Promise<IPCResult<void>>;
  getState(): Promise<IPCResult<SchedulerStatePayload>>;
  onStateChanged(callback: (payload: SchedulerStatePayload) => void): () => void;
  onCapturingStarted(callback: () => void): () => void;
  onCapturingFinished(callback: () => void): () => void;
}

const screenCaptureApi: ScreenCaptureApi = {
  async start(): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.SCREEN_CAPTURE_START);
  },

  async stop(): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.SCREEN_CAPTURE_STOP);
  },

  async pause(): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.SCREEN_CAPTURE_PAUSE);
  },

  async resume(): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.SCREEN_CAPTURE_RESUME);
  },

  async getState(): Promise<IPCResult<SchedulerStatePayload>> {
    return ipcRenderer.invoke(IPC_CHANNELS.SCREEN_CAPTURE_GET_STATE);
  },

  onStateChanged(callback: (payload: SchedulerStatePayload) => void) {
    const subscription = (_event: unknown, payload: SchedulerStatePayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.SCREEN_CAPTURE_STATE_CHANGED, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCREEN_CAPTURE_STATE_CHANGED, subscription);
    };
  },

  onCapturingStarted(callback: () => void) {
    const subscription = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SCREEN_CAPTURE_CAPTURING_STARTED, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCREEN_CAPTURE_CAPTURING_STARTED, subscription);
    };
  },

  onCapturingFinished(callback: () => void) {
    const subscription = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SCREEN_CAPTURE_CAPTURING_FINISHED, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCREEN_CAPTURE_CAPTURING_FINISHED, subscription);
    };
  },
};

contextBridge.exposeInMainWorld("screenCaptureApi", screenCaptureApi);

export interface UserSettingsApi {
  get(): Promise<IPCResult<UserSettingsResponse>>;
  update(settings: UpdateUserSettingsRequest["settings"]): Promise<IPCResult<UserSettingsResponse>>;
  setCaptureOverride(mode: CaptureManualOverride): Promise<IPCResult<UserSettingsResponse>>;
  setOnboardingProgress(progress: OnboardingProgress): Promise<IPCResult<UserSettingsResponse>>;
}

const userSettingsApi: UserSettingsApi = {
  async get(): Promise<IPCResult<UserSettingsResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.USER_SETTINGS_GET);
  },

  async update(
    settings: UpdateUserSettingsRequest["settings"]
  ): Promise<IPCResult<UserSettingsResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.USER_SETTINGS_UPDATE, { settings });
  },

  async setCaptureOverride(mode: CaptureManualOverride): Promise<IPCResult<UserSettingsResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.USER_SETTINGS_SET_CAPTURE_OVERRIDE, { mode });
  },

  async setOnboardingProgress(
    progress: OnboardingProgress
  ): Promise<IPCResult<UserSettingsResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.USER_SETTINGS_SET_ONBOARDING_PROGRESS, {
      progress,
    } satisfies SetOnboardingProgressRequest);
  },
};

contextBridge.exposeInMainWorld("userSettingsApi", userSettingsApi);

export interface NotificationApi {
  show(notification: ShowNotificationRequest["notification"]): Promise<IPCResult<void>>;
  getPreferences(): Promise<IPCResult<NotificationPreferencesResponse>>;
  updatePreferences(
    preferences: NotificationPreferencesRequest["preferences"]
  ): Promise<IPCResult<NotificationPreferencesResponse>>;
  onNotificationClick(callback: (payload: NotificationClickPayload) => void): () => void;
  onNotificationToast(callback: (payload: NotificationToastPayload) => void): () => void;
}

const notificationApi: NotificationApi = {
  async show(notification): Promise<IPCResult<void>> {
    return ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_SHOW, {
      notification,
    } satisfies ShowNotificationRequest);
  },
  async getPreferences(): Promise<IPCResult<NotificationPreferencesResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_GET_PREFERENCES);
  },
  async updatePreferences(
    preferences: NotificationPreferencesRequest["preferences"]
  ): Promise<IPCResult<NotificationPreferencesResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_UPDATE_PREFERENCES, {
      preferences,
    } satisfies NotificationPreferencesRequest);
  },
  onNotificationClick(callback: (payload: NotificationClickPayload) => void) {
    const subscription = (_event: unknown, payload: NotificationClickPayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_ON_CLICK, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_ON_CLICK, subscription);
    };
  },
  onNotificationToast(callback: (payload: NotificationToastPayload) => void) {
    const subscription = (_event: unknown, payload: NotificationToastPayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_TOAST, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_TOAST, subscription);
    };
  },
};

contextBridge.exposeInMainWorld("notificationApi", notificationApi);

export interface ThreadsApi {
  getActiveState(): Promise<IPCResult<ThreadsGetActiveStateResponse>>;
  getActiveCandidates(): Promise<IPCResult<ThreadsGetActiveCandidatesResponse>>;
  getResolvedActive(): Promise<IPCResult<ThreadsGetResolvedActiveResponse>>;
  getLensState(): Promise<IPCResult<ThreadsGetLensStateResponse>>;
  onLensStateChanged(callback: (payload: ThreadLensStateChangedPayload) => void): () => void;
  onThreadBriefUpdated(callback: (payload: ThreadBriefUpdatedPayload) => void): () => void;
  pin(request: ThreadsPinRequest): Promise<IPCResult<ThreadsPinResponse>>;
  unpin(): Promise<IPCResult<ThreadsUnpinResponse>>;
  get(request: ThreadsGetByIdRequest): Promise<IPCResult<ThreadsGetResponse>>;
  list(request: ThreadsListRequest): Promise<IPCResult<ThreadsListResponse>>;
  getBrief(request: ThreadsGetBriefRequest): Promise<IPCResult<ThreadsGetBriefResponse>>;
  markInactive(
    request: ThreadsMarkInactiveRequest
  ): Promise<IPCResult<ThreadsMarkInactiveResponse>>;
}

const threadsApi: ThreadsApi = {
  async getActiveState(): Promise<IPCResult<ThreadsGetActiveStateResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_GET_ACTIVE_STATE);
  },
  async getActiveCandidates(): Promise<IPCResult<ThreadsGetActiveCandidatesResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_GET_ACTIVE_CANDIDATES);
  },
  async getResolvedActive(): Promise<IPCResult<ThreadsGetResolvedActiveResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_GET_RESOLVED_ACTIVE);
  },
  async getLensState(): Promise<IPCResult<ThreadsGetLensStateResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_GET_LENS_STATE);
  },
  onLensStateChanged(callback: (payload: ThreadLensStateChangedPayload) => void) {
    const subscription = (_event: unknown, payload: ThreadLensStateChangedPayload) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.THREADS_LENS_STATE_CHANGED, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.THREADS_LENS_STATE_CHANGED, subscription);
    };
  },
  onThreadBriefUpdated(callback: (payload: ThreadBriefUpdatedPayload) => void) {
    const subscription = (_event: unknown, payload: ThreadBriefUpdatedPayload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.THREADS_BRIEF_UPDATED, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.THREADS_BRIEF_UPDATED, subscription);
    };
  },
  async pin(request: ThreadsPinRequest): Promise<IPCResult<ThreadsPinResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_PIN, request);
  },
  async unpin(): Promise<IPCResult<ThreadsUnpinResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_UNPIN);
  },
  async get(request: ThreadsGetByIdRequest): Promise<IPCResult<ThreadsGetResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_GET, request);
  },
  async list(request: ThreadsListRequest): Promise<IPCResult<ThreadsListResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_LIST, request);
  },
  async getBrief(request: ThreadsGetBriefRequest): Promise<IPCResult<ThreadsGetBriefResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_GET_BRIEF, request);
  },
  async markInactive(
    request: ThreadsMarkInactiveRequest
  ): Promise<IPCResult<ThreadsMarkInactiveResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.THREADS_MARK_INACTIVE, request);
  },
};

contextBridge.exposeInMainWorld("threadsApi", threadsApi);

// --------- Expose Capture Source Settings API to the Renderer process ---------
export interface CaptureSourceApi {
  initServices(): Promise<IPCResult<boolean>>;
  getScreens(): Promise<IPCResult<GetScreensResponse>>;
  getApps(): Promise<IPCResult<GetAppsResponse>>;
  getPreferences(): Promise<IPCResult<PreferencesResponse>>;
  setPreferences(preferences: Partial<CapturePreferences>): Promise<IPCResult<PreferencesResponse>>;
}

const captureSourceApi: CaptureSourceApi = {
  async initServices(): Promise<IPCResult<boolean>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SOURCES_INIT_SERVICES);
  },

  async getScreens(): Promise<IPCResult<GetScreensResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SOURCES_GET_SCREENS);
  },

  async getApps(): Promise<IPCResult<GetAppsResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SOURCES_GET_APPS);
  },

  async getPreferences(): Promise<IPCResult<PreferencesResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SOURCES_GET_PREFERENCES);
  },

  async setPreferences(
    preferences: Partial<CapturePreferences>
  ): Promise<IPCResult<PreferencesResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SOURCES_SET_PREFERENCES, { preferences });
  },
};

contextBridge.exposeInMainWorld("captureSourceApi", captureSourceApi);
export interface ContextGraphApi {
  search(query: SearchQuery): Promise<IPCResult<SearchResult>>;
  cancelSearch(): Promise<IPCResult<boolean>>;
  getThread(threadId: string): Promise<IPCResult<ExpandedContextNode[]>>;
  getEvidence(nodeIds: number[]): Promise<IPCResult<ScreenshotEvidence[]>>;
}

const contextGraphApi: ContextGraphApi = {
  async search(query: SearchQuery): Promise<IPCResult<SearchResult>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_SEARCH, query);
  },

  async cancelSearch(): Promise<IPCResult<boolean>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_SEARCH_CANCEL);
  },

  async getThread(threadId: string): Promise<IPCResult<ExpandedContextNode[]>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_GET_THREAD, threadId);
  },

  async getEvidence(nodeIds: number[]): Promise<IPCResult<ScreenshotEvidence[]>> {
    return ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_GET_EVIDENCE, nodeIds);
  },
};

contextBridge.exposeInMainWorld("contextGraphApi", contextGraphApi);

export interface UsageApi {
  getSummary(
    range: import("@shared/ipc-types").UsageTimeRangePayload
  ): Promise<IPCResult<import("@shared/ipc-types").UsageSummaryResult>>;
  getDaily(
    range: import("@shared/ipc-types").UsageTimeRangePayload
  ): Promise<IPCResult<import("@shared/ipc-types").UsageDailyItem[]>>;
  getBreakdown(
    range: import("@shared/ipc-types").UsageTimeRangePayload
  ): Promise<IPCResult<import("@shared/ipc-types").UsageBreakdownItem[]>>;
}

const usageApi: UsageApi = {
  async getSummary(
    range: import("@shared/ipc-types").UsageTimeRangePayload
  ): Promise<IPCResult<import("@shared/ipc-types").UsageSummaryResult>> {
    return ipcRenderer.invoke(IPC_CHANNELS.USAGE_GET_SUMMARY, range);
  },

  async getDaily(
    range: import("@shared/ipc-types").UsageTimeRangePayload
  ): Promise<IPCResult<import("@shared/ipc-types").UsageDailyItem[]>> {
    return ipcRenderer.invoke(IPC_CHANNELS.USAGE_GET_DAILY, range);
  },

  async getBreakdown(
    range: import("@shared/ipc-types").UsageTimeRangePayload
  ): Promise<IPCResult<import("@shared/ipc-types").UsageBreakdownItem[]>> {
    return ipcRenderer.invoke(IPC_CHANNELS.USAGE_GET_BREAKDOWN, range);
  },
};

export interface AppApi {
  onNavigate(callback: (path: string) => void): () => void;
  updateTitleBar(payload: import("@shared/ipc-types").AppUpdateTitleBarPayload): Promise<void>;
}

const appApi: AppApi = {
  onNavigate(callback: (path: string) => void) {
    const subscription = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(IPC_CHANNELS.APP_NAVIGATE, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.APP_NAVIGATE, subscription);
    };
  },
  async updateTitleBar(
    payload: import("@shared/ipc-types").AppUpdateTitleBarPayload
  ): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_TITLE_BAR, payload);
  },
};

contextBridge.exposeInMainWorld("appApi", appApi);
contextBridge.exposeInMainWorld("usageApi", usageApi);

// --------- Expose Activity Monitor API to the Renderer process ---------
export interface ActivityMonitorApi {
  getTimeline(request: TimelineRequest): Promise<IPCResult<TimelineResponse>>;
  getSummary(request: SummaryRequest): Promise<IPCResult<SummaryResponse | null>>;
  getEventDetails(request: EventDetailsRequest): Promise<IPCResult<EventDetailsResponse>>;
  regenerateSummary(
    request: RegenerateSummaryRequest
  ): Promise<IPCResult<RegenerateSummaryResponse>>;
  onTimelineChanged(callback: (payload: ActivityTimelineChangedPayload) => void): () => void;
}

const activityMonitorApi: ActivityMonitorApi = {
  async getTimeline(request: TimelineRequest): Promise<IPCResult<TimelineResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_GET_TIMELINE, request);
  },

  async getSummary(request: SummaryRequest): Promise<IPCResult<SummaryResponse | null>> {
    return ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_GET_SUMMARY, request);
  },

  async getEventDetails(request: EventDetailsRequest): Promise<IPCResult<EventDetailsResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_GET_EVENT_DETAILS, request);
  },

  async regenerateSummary(
    request: RegenerateSummaryRequest
  ): Promise<IPCResult<RegenerateSummaryResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_REGENERATE_SUMMARY, request);
  },

  onTimelineChanged(callback: (payload: ActivityTimelineChangedPayload) => void) {
    const subscription = (_event: unknown, payload: ActivityTimelineChangedPayload) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.ACTIVITY_TIMELINE_CHANGED, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ACTIVITY_TIMELINE_CHANGED, subscription);
    };
  },
};

contextBridge.exposeInMainWorld("activityMonitorApi", activityMonitorApi);

export interface MonitoringApi {
  openDashboard(): Promise<IPCResult<MonitoringOpenDashboardResult>>;
}

const monitoringApi: MonitoringApi = {
  async openDashboard(): Promise<IPCResult<MonitoringOpenDashboardResult>> {
    return ipcRenderer.invoke(IPC_CHANNELS.MONITORING_OPEN_DASHBOARD);
  },
};

contextBridge.exposeInMainWorld("monitoringApi", monitoringApi);
