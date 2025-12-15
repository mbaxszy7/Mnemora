import { z } from "zod/v4";
import { IPCResult } from "./ipc-types";

export const VLMResponseSchema = z.object({
  title: z.string().describe("Brief title of the image content"),
  description: z.string().describe("Detailed description of the image content"),
  objects: z.array(z.string()).describe("List of objects recognized in the image"),
  text: z.array(z.string()).optional().describe("List of text recognized in the image"),
  confidence: z.number().min(0).max(100).describe("Analysis confidence level"),
});

export type VLMResponse = z.infer<typeof VLMResponseSchema>;

/**
 * Generate JSON Schema with descriptions as the prompt example
 * The schema itself serves as both format specification and field documentation
 * Zod v4 has built-in toJsonSchema support
 */
export const VLM_RESPONSE_JSON_SCHEMA = z.toJSONSchema(VLMResponseSchema);

export interface VLMAnalyzeRequest {
  imageData: string; // base64 encoded
  mimeType: string;
}

export type VLMAnalyzeResponse = IPCResult<VLMResponse>;

export interface VLMStatusResponse {
  initialized: boolean;
  model: string;
}

export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
