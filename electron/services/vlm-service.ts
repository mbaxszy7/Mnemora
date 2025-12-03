import { generateText } from "ai";
import { AISDKService } from "./ai-sdk-service";
import { ServiceError, ErrorCode } from "@shared/errors";
import {
  VLMResponseSchema,
  VLMAnalyzeResponse,
  MAX_IMAGE_SIZE,
  SUPPORTED_IMAGE_TYPES,
  type SupportedImageType,
  VLM_RESPONSE_JSON_SCHEMA,
} from "@shared/vlm-types";
import { toIPCError } from "@shared/ipc-types";
import { VLM_PROMPT_TEMPLATE } from "@shared/prompts";
import { getLogger } from "./logger";

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
  private logger = getLogger("VLMService");

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
        throw new ServiceError(ErrorCode.API_KEY_MISSING, "Please configure API Key");
      }

      // Validate image type
      if (!SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType)) {
        throw new ServiceError(ErrorCode.INVALID_IMAGE_TYPE, "Unsupported image format");
      }

      // Validate image size
      if (imageBuffer.length > MAX_IMAGE_SIZE) {
        throw new ServiceError(ErrorCode.IMAGE_TOO_LARGE, "Image too large");
      }

      const client = this.aiService.getClient();
      const base64Image = imageBuffer.toString("base64");
      const dataUrl = `data:${mimeType};base64,${base64Image}`;

      const prompt = await VLM_PROMPT_TEMPLATE.user.invoke({
        vlm_response_schema: JSON.stringify(VLM_RESPONSE_JSON_SCHEMA, null, 2),
      });

      this.logger.info(`VLM prompt: ${prompt.value}`);

      // Call VLM with generateText and parse JSON response manually
      const result = await generateText({
        model: client,
        system: VLM_PROMPT_TEMPLATE.system,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt.value,
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

      // Validate the response with Zod schema
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
