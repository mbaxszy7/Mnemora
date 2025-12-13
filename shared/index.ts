// Errors
export { ErrorCode, ERROR_MESSAGES, getErrorMessage, ServiceError } from "./errors";

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

// LLM Configuration Types
export {
  type LLMConfigMode,
  type LLMEndpointConfig,
  type UnifiedLLMConfig,
  type SeparateLLMConfig,
  type LLMConfig,
  type CapabilityValidationResult,
  type LLMValidationResult,
  type LLMConfigCheckResult,
  LLMValidationErrorCode,
} from "./llm-config-types";

// LLM Configuration Utilities
export {
  isValidUrl,
  isEndpointConfigComplete,
  isSeparateConfigComplete,
  encodeApiKey,
  decodeApiKey,
  getValidationErrorKey,
} from "./llm-config-utils";

// Capture Source Types
export {
  type ScreenInfo,
  type AppInfo,
  type CapturePreferences,
  type GetScreensResponse,
  type GetAppsResponse,
  type SetPreferencesRequest,
  type GetPreferencesResponse,
  type SetPreferencesResponse,
} from "./capture-source-types";

// Popular Apps
export {
  type PopularAppConfig,
  POPULAR_APPS,
  DEFAULT_APP_ICON,
  findPopularApp,
  getAppIcon,
  isPopularApp,
} from "./popular-apps";
