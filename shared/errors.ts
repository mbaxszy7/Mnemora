export enum ErrorCode {
  // AI SDK related
  API_KEY_MISSING = "API_KEY_MISSING",
  NOT_INITIALIZED = "NOT_INITIALIZED",
  INITIALIZATION_ERROR = "INITIALIZATION_ERROR",

  // VLM related
  VLM_ERROR = "VLM_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE",
  INVALID_IMAGE_TYPE = "INVALID_IMAGE_TYPE",

  // General
  UNKNOWN = "UNKNOWN",
}

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.API_KEY_MISSING]: "Please configure API Key",
  [ErrorCode.NOT_INITIALIZED]: "AI service not initialized",
  [ErrorCode.INITIALIZATION_ERROR]: "AI service initialization failed",
  [ErrorCode.VLM_ERROR]: "Image analysis failed, please try again",
  [ErrorCode.VALIDATION_ERROR]: "Response format error",
  [ErrorCode.IMAGE_TOO_LARGE]: "Image too large, please select an image smaller than 20MB",
  [ErrorCode.INVALID_IMAGE_TYPE]: "Unsupported image format",
  [ErrorCode.UNKNOWN]: "An unknown error occurred, please try again",
};

export function getErrorMessage(code: ErrorCode | string): string {
  if (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
    return ERROR_MESSAGES[code as ErrorCode];
  }
  return ERROR_MESSAGES[ErrorCode.UNKNOWN];
}

export class ServiceError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
