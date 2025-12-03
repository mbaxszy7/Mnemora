/**
 * 统一错误码枚举 - 前后端共用
 */
export enum ErrorCode {
  // AI SDK 相关
  API_KEY_MISSING = "API_KEY_MISSING",
  NOT_INITIALIZED = "NOT_INITIALIZED",
  INITIALIZATION_ERROR = "INITIALIZATION_ERROR",

  // VLM 相关
  VLM_ERROR = "VLM_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE",
  INVALID_IMAGE_TYPE = "INVALID_IMAGE_TYPE",

  // 通用
  UNKNOWN = "UNKNOWN",
}

/**
 * 错误码到用户友好消息的映射
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.API_KEY_MISSING]: "请配置 API Key",
  [ErrorCode.NOT_INITIALIZED]: "AI 服务未初始化",
  [ErrorCode.INITIALIZATION_ERROR]: "AI 服务初始化失败",
  [ErrorCode.VLM_ERROR]: "图片分析失败，请重试",
  [ErrorCode.VALIDATION_ERROR]: "响应格式异常",
  [ErrorCode.IMAGE_TOO_LARGE]: "图片过大，请选择小于 20MB 的图片",
  [ErrorCode.INVALID_IMAGE_TYPE]: "不支持的图片格式",
  [ErrorCode.UNKNOWN]: "发生未知错误，请重试",
};

/**
 * 获取用户友好的错误消息
 */
export function getErrorMessage(code: ErrorCode | string): string {
  if (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
    return ERROR_MESSAGES[code as ErrorCode];
  }
  return ERROR_MESSAGES[ErrorCode.UNKNOWN];
}

/**
 * 服务错误类 - 带有错误码和详情
 */
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
