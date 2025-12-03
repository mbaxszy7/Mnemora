import { ipcRenderer, contextBridge } from "electron";
import { IPC_CHANNELS, IPCResult } from "@shared/ipc-types";
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse } from "@shared/vlm-types";

/**
 * VLM API exposed to renderer process
 */
export interface VLMApi {
  analyze(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse>;
  getStatus(): Promise<IPCResult<VLMStatusResponse>>;
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
  /**
   * Analyze an image using VLM
   * @param imageData - Base64 encoded image data
   * @param mimeType - MIME type of the image (e.g., 'image/jpeg', 'image/png')
   * @returns Promise with analysis result or error
   */
  async analyze(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse> {
    const request: VLMAnalyzeRequest = { imageData, mimeType };
    return ipcRenderer.invoke(IPC_CHANNELS.VLM_ANALYZE, request);
  },

  /**
   * Get VLM service status
   * @returns Promise with initialization status and current model
   */
  async getStatus(): Promise<IPCResult<VLMStatusResponse>> {
    return ipcRenderer.invoke(IPC_CHANNELS.VLM_STATUS);
  },
};

contextBridge.exposeInMainWorld("vlmApi", vlmApi);

// Type declarations are in electron-env.d.ts
