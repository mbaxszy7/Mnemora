import { z } from "zod";
import { IPCResult } from "./ipc-types";

/**
 * VLM Response Schema - for structured output validation
 */
export const VLMResponseSchema = z.object({
  title: z.string().describe("Brief title of the image content"),
  description: z.string().describe("Detailed description of the image content"),
  objects: z.array(z.string()).describe("List of objects recognized in the image"),
  text: z.array(z.string()).optional().describe("List of text recognized in the image"),
  confidence: z.number().min(0).max(100).describe("Analysis confidence level"),
});

export type VLMResponse = z.infer<typeof VLMResponseSchema>;

/**
 * VLM Analyze Request
 */
export interface VLMAnalyzeRequest {
  imageData: string; // base64 encoded
  mimeType: string;
}

/**
 * VLM Analyze Response
 */
export type VLMAnalyzeResponse = IPCResult<VLMResponse>;

/**
 * VLM Status Response
 */
export interface VLMStatusResponse {
  initialized: boolean;
  model: string;
}

/**
 * Supported image MIME types
 */
export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * Image size limit (20MB)
 */
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
