import { z } from "zod";
import { IPCResult } from "./ipc-types";

/**
 * VLM 响应 Schema - 用于结构化输出验证
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
 * VLM 分析请求
 */
export interface VLMAnalyzeRequest {
  imageData: string; // base64 encoded
  mimeType: string;
}

/**
 * VLM 分析响应
 */
export type VLMAnalyzeResponse = IPCResult<VLMResponse>;

/**
 * VLM 状态响应
 */
export interface VLMStatusResponse {
  initialized: boolean;
  model: string;
}

/**
 * 支持的图片 MIME 类型
 */
export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * 图片大小限制 (20MB)
 */
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
