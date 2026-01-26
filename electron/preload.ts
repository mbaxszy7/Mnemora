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
  UpdateUserSettingsRequest,
  UserSettingsResponse,
} from "@shared/user-settings-types";
import type {
  SearchQuery,
  SearchResult,
  ExpandedContextNode,
  ScreenshotEvidence,
} from "@shared/context-types";
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
};

contextBridge.exposeInMainWorld("screenCaptureApi", screenCaptureApi);

export interface UserSettingsApi {
  get(): Promise<IPCResult<UserSettingsResponse>>;
  update(settings: UpdateUserSettingsRequest["settings"]): Promise<IPCResult<UserSettingsResponse>>;
  setCaptureOverride(mode: CaptureManualOverride): Promise<IPCResult<UserSettingsResponse>>;
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
};

contextBridge.exposeInMainWorld("userSettingsApi", userSettingsApi);

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
}

const appApi: AppApi = {
  onNavigate(callback: (path: string) => void) {
    const subscription = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(IPC_CHANNELS.APP_NAVIGATE, subscription);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.APP_NAVIGATE, subscription);
    };
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
