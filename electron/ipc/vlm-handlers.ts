import type { IpcMainInvokeEvent } from "electron";
import { generateText } from "ai";
import { AISDKService } from "../services/ai-sdk-service";
import { IPC_CHANNELS, IPCResult, toIPCError } from "@shared/ipc-types";
import { ServiceError, ErrorCode } from "@shared/errors";
import {
  VLMResponseSchema,
  type VLMAnalyzeRequest,
  type VLMAnalyzeResponse,
  type VLMStatusResponse,
  MAX_IMAGE_SIZE,
  SUPPORTED_IMAGE_TYPES,
  type SupportedImageType,
  VLM_RESPONSE_JSON_SCHEMA,
} from "@shared/vlm-types";
import { VLM_PROMPT_TEMPLATE } from "@shared/prompts";
import { IPCHandlerRegistry } from "./handler-registry";
import { getLogger } from "../services/logger";

const logger = getLogger("vlm-handlers");

async function handleAnalyze(
  _event: IpcMainInvokeEvent,
  request: VLMAnalyzeRequest
): Promise<VLMAnalyzeResponse> {
  try {
    const { imageData, mimeType } = request;

    // Validate request
    if (!imageData || typeof imageData !== "string") {
      return { success: false, error: toIPCError(new Error("Invalid image data")) };
    }
    if (!mimeType || typeof mimeType !== "string") {
      return { success: false, error: toIPCError(new Error("Invalid MIME type")) };
    }

    // Validate image type
    if (!SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType)) {
      throw new ServiceError(ErrorCode.INVALID_IMAGE_TYPE, "Unsupported image format");
    }

    // Validate image size
    const imageBuffer = Buffer.from(imageData, "base64");
    if (imageBuffer.length > MAX_IMAGE_SIZE) {
      throw new ServiceError(ErrorCode.IMAGE_TOO_LARGE, "Image too large");
    }

    // Get VLM client
    const aiService = AISDKService.getInstance();
    if (!aiService.isInitialized()) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "AI SDK not initialized");
    }

    const vlmClient = aiService.getVLMClient();
    const dataUrl = `data:${mimeType};base64,${imageData}`;

    const prompt = await VLM_PROMPT_TEMPLATE.user.invoke({
      vlm_response_schema: JSON.stringify(VLM_RESPONSE_JSON_SCHEMA, null, 2),
    });

    logger.info(`VLM prompt: ${prompt.value}`);

    // Call VLM
    const result = await generateText({
      model: vlmClient,
      system: VLM_PROMPT_TEMPLATE.system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt.value },
            { type: "image", image: dataUrl },
          ],
        },
      ],
    });

    // Parse JSON from response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new ServiceError(ErrorCode.VALIDATION_ERROR, "Unable to parse JSON from response", {
        rawText: result.text,
      });
    }

    let parsedObject: unknown;
    try {
      parsedObject = JSON.parse(jsonMatch[0]);
    } catch {
      throw new ServiceError(ErrorCode.VALIDATION_ERROR, "JSON parsing failed", {
        rawText: jsonMatch[0],
      });
    }

    // Validate with Zod schema
    const parseResult = VLMResponseSchema.safeParse(parsedObject);
    if (!parseResult.success) {
      throw new ServiceError(
        ErrorCode.VALIDATION_ERROR,
        "Response format error",
        parseResult.error.issues
      );
    }

    return { success: true, data: parseResult.data };
  } catch (error) {
    return { success: false, error: toIPCError(error) };
  }
}

async function handleStatus(): Promise<IPCResult<VLMStatusResponse>> {
  try {
    const aiService = AISDKService.getInstance();
    return {
      success: true,
      data: {
        initialized: aiService.isInitialized(),
        model: "configured",
      },
    };
  } catch (error) {
    return { success: false, error: toIPCError(error) };
  }
}

export function registerVLMHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();
  registry.registerHandler(IPC_CHANNELS.VLM_ANALYZE, handleAnalyze);
  registry.registerHandler(IPC_CHANNELS.VLM_STATUS, handleStatus);
}
