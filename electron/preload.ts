import { ipcRenderer, contextBridge } from "electron";
import { IPC_CHANNELS, IPCResult } from "@shared/ipc-types";
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse } from "@shared/vlm-types";
import type { SupportedLanguage } from "@shared/i18n-types";
import type {
  LLMConfig,
  LLMConfigCheckResult,
  LLMValidationResult,
} from "@shared/llm-config-types";

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
