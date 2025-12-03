// Errors
export {
  ErrorCode,
  ERROR_MESSAGES,
  getErrorMessage,
  ServiceError,
} from "./errors";

// IPC Types
export {
  type IPCError,
  type IPCResult,
  IPC_CHANNELS,
  type IPCChannel,
  toIPCError,
} from "./ipc-types";

// VLM Types
export {
  VLMResponseSchema,
  type VLMResponse,
  type VLMAnalyzeRequest,
  type VLMAnalyzeResponse,
  type VLMStatusResponse,
  SUPPORTED_IMAGE_TYPES,
  type SupportedImageType,
  MAX_IMAGE_SIZE,
} from "./vlm-types";
