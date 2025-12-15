import { ipcRenderer, contextBridge } from "electron";
import { IPC_CHANNELS, IPCResult } from "@shared/ipc-types";
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse } from "@shared/vlm-types";
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

/**
 * VLM API exposed to renderer process
 */
export interface VLMApi {
  analyze(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse>;
  getStatus(): Promise<IPCResult<VLMStatusResponse>>;
}

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

// --------- Expose VLM API to the Renderer process ---------
const vlmApi: VLMApi = {
  async analyze(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse> {
    const request: VLMAnalyzeRequest = { imageData, mimeType };
    return ipcRenderer.invoke(IPC_CHANNELS.VLM_ANALYZE, request);
  },

  async getStatus(): Promise<IPCResult<VLMStatusResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.VLM_STATUS);
  },
};

contextBridge.exposeInMainWorld("vlmApi", vlmApi);

// --------- Expose i18n API to the Renderer process ---------
const i18nApi: I18nApi = {
  async changeLanguage(lang: SupportedLanguage): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.I18N_CHANGE_LANGUAGE, { language: lang });
  },

  async getLanguage(): Promise<SupportedLanguage> {
    return ipcRenderer.invoke(IPC_CHANNELS.I18N_GET_LANGUAGE);
  },

  /**
   * Get the system's detected language
   * @returns System language ('en' or 'zh-CN')
   */
  async getSystemLanguage(): Promise<SupportedLanguage> {
    return ipcRenderer.invoke(IPC_CHANNELS.I18N_GET_SYSTEM_LANGUAGE);
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

// --------- Expose Permission API to the Renderer process ---------
import type { PermissionCheckResult } from "@shared/ipc-types";

export interface PermissionApi {
  check(): Promise<IPCResult<PermissionCheckResult>>;
  requestScreenRecording(): Promise<IPCResult<boolean>>;
  requestAccessibility(): Promise<IPCResult<boolean>>;
  openScreenRecordingSettings(): Promise<IPCResult<void>>;
  openAccessibilitySettings(): Promise<IPCResult<void>>;
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
};

contextBridge.exposeInMainWorld("permissionApi", permissionApi);

// --------- Expose Screen Capture API to the Renderer process (TEMPORARY) ---------
import type { SchedulerStatePayload } from "@shared/ipc-types";

export interface ScreenCaptureApi {
  start(): Promise<IPCResult<void>>;
  stop(): Promise<IPCResult<void>>;
  pause(): Promise<IPCResult<void>>;
  resume(): Promise<IPCResult<void>>;
  getState(): Promise<IPCResult<SchedulerStatePayload>>;
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
};

contextBridge.exposeInMainWorld("screenCaptureApi", screenCaptureApi);

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
