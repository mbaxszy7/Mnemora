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
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, expose in `preload.ts`
// Types are imported from shared module
interface Window {
  ipcRenderer: import('electron').IpcRenderer
  vlmApi: {
    analyze(imageData: string, mimeType: string): Promise<import('../shared/vlm-types').VLMAnalyzeResponse>;
    getStatus(): Promise<import('../shared/ipc-types').IPCResult<import('../shared/vlm-types').VLMStatusResponse>>;
  }
}
