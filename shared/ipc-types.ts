import { ErrorCode, ServiceError } from "./errors";

/**
 * IPC 错误结构
 */
export interface IPCError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * 通用 IPC 结果包装器
 */
export interface IPCResult<T> {
  success: boolean;
  data?: T;
  error?: IPCError;
}

/**
 * IPC 通道定义
 */
export const IPC_CHANNELS = {
  VLM_ANALYZE: "vlm:analyze",
  VLM_STATUS: "vlm:status",
} as const;

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * 将 Error 转换为 IPCError
 */
export function toIPCError(error: unknown): IPCError {
  if (error instanceof ServiceError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: ErrorCode.UNKNOWN,
      message: error.message,
      details: error.stack,
    };
  }

  return {
    code: ErrorCode.UNKNOWN,
    message: String(error),
  };
}
