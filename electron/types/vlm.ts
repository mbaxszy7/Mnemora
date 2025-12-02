import { z } from "zod";

/**
 * VLM Response Schema - Defines the structure of VLM analysis results
 * Used for structured output validation with AI SDK generateObject
 */
export const VLMResponseSchema = z.object({
  title: z.string().describe("图片内容的简短标题"),
  description: z.string().describe("图片内容的详细描述"),
  objects: z.array(z.string()).describe("图片中识别到的物体列表"),
  text: z.array(z.string()).optional().describe("图片中识别到的文字列表"),
  confidence: z.number().min(0).max(100).describe("分析置信度"),
});

export type VLMResponse = z.infer<typeof VLMResponseSchema>;

/**
 * IPC Error codes for VLM operations
 */
export type IPCErrorCode =
  | "API_KEY_MISSING"
  | "VLM_ERROR"
  | "VALIDATION_ERROR"
  | "IMAGE_TOO_LARGE"
  | "UNKNOWN";

/**
 * IPC Error structure for error responses
 */
export interface IPCError {
  code: IPCErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Generic IPC Result wrapper for all IPC responses
 */
export interface IPCResult<T> {
  success: boolean;
  data?: T;
  error?: IPCError;
}

/**
 * VLM Analyze Request payload
 */
export interface VLMAnalyzeRequest {
  imageData: string; // base64 encoded
  mimeType: string;
}

/**
 * VLM Analyze Response type
 */
export type VLMAnalyzeResponse = IPCResult<VLMResponse>;

/**
 * VLM Status Response type
 */
export interface VLMStatusResponse {
  initialized: boolean;
  model: string;
}
