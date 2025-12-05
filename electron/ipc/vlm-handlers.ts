import type { IpcMainInvokeEvent } from "electron";
import { VLMService } from "../services/vlm-service";
import { AISDKService } from "../services/ai-sdk-service";
import { IPC_CHANNELS, IPCResult, toIPCError } from "@shared/ipc-types";
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse } from "@shared/vlm-types";
import { IPCHandlerRegistry } from "./handler-registry";

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
        error: toIPCError(new Error("Invalid image data")),
      };
    }

    if (!mimeType || typeof mimeType !== "string") {
      return {
        success: false,
        error: toIPCError(new Error("Invalid MIME type")),
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

async function handleStatus(): Promise<IPCResult<VLMStatusResponse>> {
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

export function registerVLMHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(IPC_CHANNELS.VLM_ANALYZE, handleAnalyze);

  registry.registerHandler(IPC_CHANNELS.VLM_STATUS, handleStatus);
}
