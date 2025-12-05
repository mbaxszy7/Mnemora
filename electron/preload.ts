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
  memories: {
    getAll(options?: { limit?: number; offset?: number }): Promise<unknown[]>;
    get(id: number): Promise<unknown | undefined>;
    create(data: unknown): Promise<unknown>;
    update(id: number, data: unknown): Promise<unknown | undefined>;
    delete(id: number): Promise<void>;
  };
  screenshots: {
    getAll(options?: { limit?: number; offset?: number }): Promise<unknown[]>;
    create(data: unknown): Promise<unknown>;
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
  memories: {
    async getAll(options?: { limit?: number; offset?: number }): Promise<unknown[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_MEMORIES_GET_ALL, options);
    },
    async get(id: number): Promise<unknown | undefined> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_MEMORIES_GET, id);
    },
    async create(data: unknown): Promise<unknown> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_MEMORIES_CREATE, data);
    },
    async update(id: number, data: unknown): Promise<unknown | undefined> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_MEMORIES_UPDATE, id, data);
    },
    async delete(id: number): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_MEMORIES_DELETE, id);
    },
  },
  screenshots: {
    async getAll(options?: { limit?: number; offset?: number }): Promise<unknown[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_SCREENSHOTS_GET_ALL, options);
    },
    async create(data: unknown): Promise<unknown> {
      return ipcRenderer.invoke(IPC_CHANNELS.DB_SCREENSHOTS_CREATE, data);
    },
  },
};

contextBridge.exposeInMainWorld("databaseApi", databaseApi);
