import { generateObject } from "ai";
import { getClient, getModel, isInitialized, AISDKError } from "./ai-sdk";
import {
  VLMResponseSchema,
  VLMResponse,
  IPCResult,
  IPCError,
} from "../types/vlm";

/**
 * Maximum image size in bytes (20MB)
 */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/**
 * VLM Service Error
 */
export class VLMServiceError extends Error {
  constructor(
    public code: IPCError["code"],
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "VLMServiceError";
  }
}

/**
 * Convert error to IPCError format
 */
function toIPCError(error: unknown): IPCError {
  if (error instanceof VLMServiceError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof AISDKError) {
    return {
      code: error.code === "API_KEY_MISSING" ? "API_KEY_MISSING" : "VLM_ERROR",
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message: error.message,
      details: error.stack,
    };
  }

  return {
    code: "UNKNOWN",
    message: String(error),
  };
}

/**
 * Analyze an image using VLM (Vision Language Model)
 *
 * @param imageBuffer - The image data as a Buffer
 * @param mimeType - The MIME type of the image (e.g., 'image/jpeg', 'image/png')
 * @returns Promise<IPCResult<VLMResponse>> - The analysis result wrapped in IPCResult
 */
export async function analyzeImage(
  imageBuffer: Buffer,
  mimeType: string
): Promise<IPCResult<VLMResponse>> {
  try {
    // Check if AI SDK is initialized
    if (!isInitialized()) {
      throw new VLMServiceError("API_KEY_MISSING", "请配置 OpenAI API Key");
    }

    // Validate image size
    if (imageBuffer.length > MAX_IMAGE_SIZE) {
      throw new VLMServiceError(
        "IMAGE_TOO_LARGE",
        "图片过大，请选择小于 20MB 的图片"
      );
    }

    // Get the OpenAI client
    const client = getClient();
    // const model = getModel();

    // Convert buffer to base64 data URL
    const base64Image = imageBuffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    console.log("generateObject");

    // Call VLM with generateObject for structured output
    const result = await generateObject({
      model: client,
      schema: VLMResponseSchema,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请分析这张图片，提供标题、描述、识别到的物体列表、图片中的文字（如果有），以及你的分析置信度（0-100）。",
            },
            {
              type: "image",
              image: dataUrl,
            },
          ],
        },
      ],
    });

    // Validate the response with Zod schema
    const parseResult = VLMResponseSchema.safeParse(result.object);

    if (!parseResult.success) {
      throw new VLMServiceError(
        "VALIDATION_ERROR",
        "响应格式异常",
        parseResult.error.issues
      );
    }

    return {
      success: true,
      data: parseResult.data,
    };
  } catch (error) {
    console.log(error);
    // If it's already a VLMServiceError or AISDKError, convert to IPCError
    if (error instanceof VLMServiceError || error instanceof AISDKError) {
      return {
        success: false,
        error: toIPCError(error),
      };
    }

    // Handle API errors
    if (error instanceof Error && error.message.includes("API")) {
      return {
        success: false,
        error: {
          code: "VLM_ERROR",
          message: "图片分析失败，请重试",
          details: error.message,
        },
      };
    }

    // Unknown error
    return {
      success: false,
      error: toIPCError(error),
    };
  }
}

/**
 * Analyze an image from base64 string
 * Convenience method for IPC handlers
 *
 * @param imageData - Base64 encoded image data
 * @param mimeType - The MIME type of the image
 * @returns Promise<IPCResult<VLMResponse>> - The analysis result
 */
export async function analyzeImageFromBase64(
  imageData: string,
  mimeType: string
): Promise<IPCResult<VLMResponse>> {
  try {
    const imageBuffer = Buffer.from(imageData, "base64");
    return analyzeImage(imageBuffer, mimeType);
  } catch (error) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: "图片数据解析失败",
        details: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
