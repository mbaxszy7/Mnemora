import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { analyzeImageFromBase64 } from '../services/vlm-service';
import { isInitialized, getModel } from '../services/ai-sdk';
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse, IPCResult } from '../types/vlm';

/**
 * IPC Channel definitions for VLM operations
 */
export const VLM_CHANNELS = {
  ANALYZE: 'vlm:analyze',
  STATUS: 'vlm:status',
} as const;

/**
 * Handle VLM analyze request
 * Receives base64 image data and returns analysis result
 */
async function handleAnalyze(
  _event: IpcMainInvokeEvent,
  request: VLMAnalyzeRequest
): Promise<VLMAnalyzeResponse> {
  try {
    const { imageData, mimeType } = request;
    
    // Validate request
    if (!imageData || typeof imageData !== 'string') {
      return {
        success: false,
        error: {
          code: 'UNKNOWN',
          message: '无效的图片数据',
        },
      };
    }
    
    if (!mimeType || typeof mimeType !== 'string') {
      return {
        success: false,
        error: {
          code: 'UNKNOWN',
          message: '无效的 MIME 类型',
        },
      };
    }
    
    // Call VLM service
    const result = await analyzeImageFromBase64(imageData, mimeType);
    return result;
  } catch (error) {
    // Serialize error properly for IPC
    return {
      success: false,
      error: {
        code: 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof Error ? error.stack : undefined,
      },
    };
  }
}

/**
 * Handle VLM status request
 * Returns initialization status and current model
 */
async function handleStatus(
  _event: IpcMainInvokeEvent
): Promise<IPCResult<VLMStatusResponse>> {
  try {
    const initialized = isInitialized();
    const model = getModel();
    
    return {
      success: true,
      data: {
        initialized,
        model,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Register all VLM IPC handlers
 * Should be called during app initialization
 */
export function registerVLMHandlers(): void {
  ipcMain.handle(VLM_CHANNELS.ANALYZE, handleAnalyze);
  ipcMain.handle(VLM_CHANNELS.STATUS, handleStatus);
}

/**
 * Unregister all VLM IPC handlers
 * Useful for cleanup and testing
 */
export function unregisterVLMHandlers(): void {
  ipcMain.removeHandler(VLM_CHANNELS.ANALYZE);
  ipcMain.removeHandler(VLM_CHANNELS.STATUS);
}
