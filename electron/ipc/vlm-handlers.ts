import { IpcMainInvokeEvent } from "electron";
import { VLMService } from "../services/vlm-service";
import { AISDKService } from "../services/ai-sdk-service";
import { IPC_CHANNELS, IPCResult, toIPCError } from "@shared/ipc-types";
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse } from "@shared/vlm-types";
import { IPCHandlerRegistry } from "./handler-registry";

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
    if (!imageData || typeof imageData !== "string") {
      return {
        success: false,
        error: toIPCError(new Error("无效的图片数据")),
      };
    }

    if (!mimeType || typeof mimeType !== "string") {
      return {
        success: false,
        error: toIPCError(new Error("无效的 MIME 类型")),
      };
    }

    // Use VLMService singleton
    const vlmService = VLMService.getInstance();
    return await vlmService.analyzeImageFromBase64(imageData, mimeType);
  } catch (error) {
    return {
      success: false,
      error: toIPCError(error),
    };
  }
}

/**
 * Handle VLM status request
 * Returns initialization status and current model
 */
async function handleStatus(_event: IpcMainInvokeEvent): Promise<IPCResult<VLMStatusResponse>> {
  try {
    const aiService = AISDKService.getInstance();
    const initialized = aiService.isInitialized();
    const model = aiService.getModel();

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
      error: toIPCError(error),
    };
  }
}

/**
 * Register all VLM IPC handlers using IPCHandlerRegistry
 * Should be called during app initialization
 */
export function registerVLMHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler<VLMAnalyzeRequest, VLMAnalyzeResponse>(
    IPC_CHANNELS.VLM_ANALYZE,
    handleAnalyze
  );

  registry.registerHandler<void, IPCResult<VLMStatusResponse>>(
    IPC_CHANNELS.VLM_STATUS,
    handleStatus
  );
}
