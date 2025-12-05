import { ipcRenderer, contextBridge } from "electron";
import { IPC_CHANNELS, IPCResult } from "@shared/ipc-types";
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse } from "@shared/vlm-types";
import type { SupportedLanguage } from "@shared/i18n-types";

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

// --------- Expose Database API to the Renderer process ---------
export interface DatabaseApi {
  settings: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    getAll(): Promise<Array<{ key: string; value: string | null }>>;
  };
}

const databaseApi: DatabaseApi = {
  settings: {
    async get(key: string): Promise<string | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_SETTINGS_GET, key);
    },
    async set(key: string, value: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_SETTINGS_SET, key, value);
    },
    async getAll(): Promise<Array<{ key: string; value: string | null }>> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_SETTINGS_GET_ALL);
    },
  },
};

contextBridge.exposeInMainWorld("databaseApi", databaseApi);
