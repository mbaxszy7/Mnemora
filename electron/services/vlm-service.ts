import { generateText } from "ai";
import { AISDKService } from "./ai-sdk-service";
import { ServiceError, ErrorCode } from "@shared/errors";
import {
  VLMResponseSchema,
  VLMAnalyzeResponse,
  MAX_IMAGE_SIZE,
  SUPPORTED_IMAGE_TYPES,
  type SupportedImageType,
} from "@shared/vlm-types";
import { toIPCError } from "@shared/ipc-types";

/**
 * VLMService - Singleton class for Vision Language Model operations
 *
 * Provides image analysis capabilities using the AI SDK.
 * Depends on AISDKService for API client access.
 *
 * **Feature: ai-sdk-refactor**
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 */
export class VLMService {
  private static instance: VLMService | null = null;
  private aiService: AISDKService;

  /**
   * Private constructor to enforce singleton pattern
   * Initializes with AISDKService dependency
   */
  private constructor() {
    this.aiService = AISDKService.getInstance();
  }

  /**
   * Get the singleton instance of VLMService
   * @returns The singleton VLMService instance
   */
  static getInstance(): VLMService {
    if (!VLMService.instance) {
      VLMService.instance = new VLMService();
    }
    return VLMService.instance;
  }

  /**
   * Reset the singleton instance (for testing purposes only)
   */
  static resetInstance(): void {
    VLMService.instance = null;
  }

  /**
   * Analyze an image using VLM (Vision Language Model)
   *
   * @param imageBuffer - The image data as a Buffer
   * @param mimeType - The MIME type of the image (e.g., 'image/jpeg', 'image/png')
   * @returns Promise<VLMAnalyzeResponse> - The analysis result wrapped in IPCResult
   */
  async analyzeImage(imageBuffer: Buffer, mimeType: string): Promise<VLMAnalyzeResponse> {
    try {
      // Check if AI SDK is initialized
      if (!this.aiService.isInitialized()) {
        throw new ServiceError(ErrorCode.API_KEY_MISSING, "请配置 API Key");
      }

      // Validate image type
      if (!SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType)) {
        throw new ServiceError(ErrorCode.INVALID_IMAGE_TYPE, "不支持的图片格式");
      }

      // Validate image size
      if (imageBuffer.length > MAX_IMAGE_SIZE) {
        throw new ServiceError(ErrorCode.IMAGE_TOO_LARGE, "图片过大");
      }

      const client = this.aiService.getClient();
      const base64Image = imageBuffer.toString("base64");
      const dataUrl = `data:${mimeType};base64,${base64Image}`;

      // Call VLM with generateText and parse JSON response manually
      const result = await generateText({
        model: client,
        system: "你是一位图像分析专家，你的任务是分析图片中的内容，并以 JSON 格式返回结果。",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `请分析这张图片，并以 JSON 格式返回结果。JSON 格式如下：
{
  "title": "图片内容的简短标题",
  "description": "图片内容的详细描述",
  "objects": ["物体1", "物体2"],
  "text": ["识别到的文字1", "识别到的文字2"],
  "confidence": 85
}

注意：
- title: 字符串，图片的简短标题
- description: 字符串，详细描述
- objects: 字符串数组，识别到的物体列表
- text: 字符串数组（可选），图片中的文字，如果没有文字可以省略或返回空数组
- confidence: 数字 0-100，分析置信度

请只返回 JSON，不要包含其他文字。`,
              },
              {
                type: "image",
                image: dataUrl,
              },
            ],
          },
        ],
      });

      // Parse JSON from text response
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new ServiceError(ErrorCode.VALIDATION_ERROR, "无法解析响应中的 JSON", {
          rawText: result.text,
        });
      }

      let parsedObject: unknown;
      try {
        parsedObject = JSON.parse(jsonMatch[0]);
      } catch {
        throw new ServiceError(ErrorCode.VALIDATION_ERROR, "JSON 解析失败", {
          rawText: jsonMatch[0],
        });
      }

      // Validate the response with Zod schema
      const parseResult = VLMResponseSchema.safeParse(parsedObject);

      if (!parseResult.success) {
        throw new ServiceError(
          ErrorCode.VALIDATION_ERROR,
          "响应格式异常",
          parseResult.error.issues
        );
      }

      return { success: true, data: parseResult.data };
    } catch (error) {
      return { success: false, error: toIPCError(error) };
    }
  }

  /**
   * Analyze an image from base64 string
   * Convenience method for IPC handlers
   *
   * @param imageData - Base64 encoded image data
   * @param mimeType - The MIME type of the image
   * @returns Promise<VLMAnalyzeResponse> - The analysis result
   */
  async analyzeImageFromBase64(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse> {
    try {
      const imageBuffer = Buffer.from(imageData, "base64");
      return this.analyzeImage(imageBuffer, mimeType);
    } catch (error) {
      return { success: false, error: toIPCError(error) };
    }
  }
}
