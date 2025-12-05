/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string;
    /** /dist/ or /public/ */
    VITE_PUBLIC: string;
  }
}

// Used in Renderer process, expose in `preload.ts`
// Types are imported from shared module
interface Window {
  ipcRenderer: import("electron").IpcRenderer;
  vlmApi: {
    analyze(
      imageData: string,
      mimeType: string
    ): Promise<import("../shared/vlm-types").VLMAnalyzeResponse>;
    getStatus(): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/vlm-types").VLMStatusResponse>
    >;
  };
  i18nApi: {
    changeLanguage(lang: import("../shared/i18n-types").SupportedLanguage): Promise<void>;
    getLanguage(): Promise<import("../shared/i18n-types").SupportedLanguage>;
    getSystemLanguage(): Promise<import("../shared/i18n-types").SupportedLanguage>;
  };
  databaseApi: {
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
  };
}
