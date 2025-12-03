# Design Document: AI SDK Refactor

## Overview

本设计文档描述了对 Mnemora Electron 应用中 AI SDK 集成的重构方案。核心目标是：

1. **类型统一** - 将所有共享类型（错误码、API 响应、请求类型）集中在 `shared/` 目录
2. **单例模式** - 使用 class + singleton 模式实现 AISDKService 和 VLMService
3. **可扩展性** - 设计支持未来添加更多 AI 服务和 IPC 通道
4. **类型安全** - 前后端共用类型定义，确保 IPC 边界类型安全

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        shared/ (前后端共享)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ errors.ts   │  │ ipc-types.ts│  │ vlm-types.ts│  │ index.ts   │ │
│  │ - ErrorCode │  │ - IPCResult │  │ - VLMSchema │  │ - exports  │ │
│  │ - Service   │  │ - IPCError  │  │ - VLMReq/Res│  │            │ │
│  │   Error     │  │ - Channels  │  │             │  │            │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Renderer (React)│  │   Preload.ts    │  │  Main Process   │
│                 │  │                 │  │                 │
│ import { ... }  │  │ import { ... }  │  │ import { ... }  │
│ from 'shared'   │  │ from 'shared'   │  │ from 'shared'   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Main Process Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Main Process (Node.js)                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Services Layer                         │   │
│  │  ┌─────────────────────┐    ┌─────────────────────────┐  │   │
│  │  │   AISDKService      │    │     VLMService          │  │   │
│  │  │   (Singleton)       │◀───│     (Singleton)         │  │   │
│  │  │                     │    │                         │  │   │
│  │  │ - getInstance()     │    │ - getInstance()         │  │   │
│  │  │ - initialize()      │    │ - analyzeImage()        │  │   │
│  │  │ - getClient()       │    │ - analyzeImageBase64()  │  │   │
│  │  │ - isInitialized()   │    │                         │  │   │
│  │  └─────────────────────┘    └─────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│  ┌──────────────────────────┴───────────────────────────────┐   │
│  │                      IPC Layer                            │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │              IPCHandlerRegistry                      │ │   │
│  │  │  - registerHandler<Channel>()                        │ │   │
│  │  │  - channels: VLM_ANALYZE, VLM_STATUS, ...           │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. Shared Types Module (`shared/`)

所有前后端共享的类型定义。

#### 1.1 Error Types (`shared/errors.ts`)

```typescript
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
  if (code in ERROR_MESSAGES) {
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
```

#### 1.2 IPC Types (`shared/ipc-types.ts`)

```typescript
import { ErrorCode } from "./errors";

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
```

#### 1.3 VLM Types (`shared/vlm-types.ts`)

```typescript
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
```

### 2. AISDKService (`electron/services/ai-sdk-service.ts`)

单例模式实现的 AI SDK 服务。

```typescript
import { createOpenAICompatible, OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { LanguageModel } from "ai";
import { ServiceError, ErrorCode } from "@shared/errors";

export interface AISDKConfig {
  name: string;
  apiKey: string;
  baseURL: string;
  model?: string;
}

export class AISDKService {
  private static instance: AISDKService | null = null;

  private client: OpenAICompatibleProvider | null = null;
  private config: AISDKConfig | null = null;
  private _initialized = false;

  private constructor() {}

  static getInstance(): AISDKService {
    if (!AISDKService.instance) {
      AISDKService.instance = new AISDKService();
    }
    return AISDKService.instance;
  }

  /**
   * 重置实例 (仅用于测试)
   */
  static resetInstance(): void {
    AISDKService.instance = null;
  }

  initialize(config: AISDKConfig): void {
    if (!config.apiKey || config.apiKey.trim() === "") {
      this._initialized = false;
      this.client = null;
      throw new ServiceError(ErrorCode.API_KEY_MISSING, "请配置 API Key");
    }

    try {
      this.client = createOpenAICompatible({
        name: config.name,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
      });
      this.config = config;
      this._initialized = true;
    } catch (error) {
      this._initialized = false;
      this.client = null;
      throw new ServiceError(
        ErrorCode.INITIALIZATION_ERROR,
        `AI SDK 初始化失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  getClient(): LanguageModel {
    if (!this._initialized || !this.client) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "AI SDK 未初始化");
    }
    return this.client(this.config?.model || "gpt-4o");
  }

  getModel(): string {
    return this.config?.model || "gpt-4o";
  }
}
```

### 3. VLMService (`electron/services/vlm-service.ts`)

单例模式实现的 VLM 服务。

```typescript
import { generateObject } from "ai";
import { AISDKService } from "./ai-sdk-service";
import { ServiceError, ErrorCode } from "@shared/errors";
import {
  VLMResponseSchema,
  VLMResponse,
  VLMAnalyzeResponse,
  MAX_IMAGE_SIZE,
  SUPPORTED_IMAGE_TYPES,
  SupportedImageType,
} from "@shared/vlm-types";
import { toIPCError } from "@shared/ipc-types";

export class VLMService {
  private static instance: VLMService | null = null;
  private aiService: AISDKService;

  private constructor() {
    this.aiService = AISDKService.getInstance();
  }

  static getInstance(): VLMService {
    if (!VLMService.instance) {
      VLMService.instance = new VLMService();
    }
    return VLMService.instance;
  }

  /**
   * 重置实例 (仅用于测试)
   */
  static resetInstance(): void {
    VLMService.instance = null;
  }

  async analyzeImage(imageBuffer: Buffer, mimeType: string): Promise<VLMAnalyzeResponse> {
    try {
      // 检查 AI SDK 是否初始化
      if (!this.aiService.isInitialized()) {
        throw new ServiceError(ErrorCode.API_KEY_MISSING, "请配置 API Key");
      }

      // 验证图片类型
      if (!SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType)) {
        throw new ServiceError(ErrorCode.INVALID_IMAGE_TYPE, "不支持的图片格式");
      }

      // 验证图片大小
      if (imageBuffer.length > MAX_IMAGE_SIZE) {
        throw new ServiceError(ErrorCode.IMAGE_TOO_LARGE, "图片过大");
      }

      const client = this.aiService.getClient();
      const base64Image = imageBuffer.toString("base64");
      const dataUrl = `data:${mimeType};base64,${base64Image}`;

      const result = await generateObject({
        model: client,
        schema: VLMResponseSchema,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "请分析这张图片，提供标题、描述、识别到的物体列表、图片中的文字（如果有），以及你的分析置信度（0-100）。",
              },
              {
                type: "image",
                image: dataUrl,
              },
            ],
          },
        ],
      });

      const parseResult = VLMResponseSchema.safeParse(result.object);
      if (!parseResult.success) {
        throw new ServiceError(
          ErrorCode.VALIDATION_ERROR,
          "响应格式异常",
          parseResult.error.issues
        );
      }

      return { success: true, data: parseResult.data };
    } catch (error) {
      return { success: false, error: toIPCError(error) };
    }
  }

  async analyzeImageFromBase64(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse> {
    try {
      const imageBuffer = Buffer.from(imageData, "base64");
      return this.analyzeImage(imageBuffer, mimeType);
    } catch (error) {
      return { success: false, error: toIPCError(error) };
    }
  }
}
```

### 4. IPC Handler Registry (`electron/ipc/handler-registry.ts`)

类型安全的 IPC 处理器注册。

```typescript
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, IPCChannel } from "@shared/ipc-types";

type IPCHandler<TRequest, TResponse> = (
  event: IpcMainInvokeEvent,
  request: TRequest
) => Promise<TResponse>;

export class IPCHandlerRegistry {
  private static instance: IPCHandlerRegistry | null = null;
  private registeredChannels: Set<string> = new Set();

  private constructor() {}

  static getInstance(): IPCHandlerRegistry {
    if (!IPCHandlerRegistry.instance) {
      IPCHandlerRegistry.instance = new IPCHandlerRegistry();
    }
    return IPCHandlerRegistry.instance;
  }

  registerHandler<TRequest, TResponse>(
    channel: IPCChannel,
    handler: IPCHandler<TRequest, TResponse>
  ): void {
    if (this.registeredChannels.has(channel)) {
      console.warn(`[IPC] Handler for ${channel} already registered, skipping`);
      return;
    }

    ipcMain.handle(channel, handler);
    this.registeredChannels.add(channel);
  }

  isRegistered(channel: IPCChannel): boolean {
    return this.registeredChannels.has(channel);
  }
}
```

### 5. Preload API (`electron/preload.ts`)

```typescript
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-types";
import type { VLMAnalyzeRequest, VLMAnalyzeResponse, VLMStatusResponse } from "@shared/vlm-types";

export interface VLMApi {
  analyze(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse>;
  getStatus(): Promise<VLMStatusResponse>;
}

const vlmApi: VLMApi = {
  analyze: (imageData: string, mimeType: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.VLM_ANALYZE, { imageData, mimeType } as VLMAnalyzeRequest),
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.VLM_STATUS),
};

contextBridge.exposeInMainWorld("vlmApi", vlmApi);

declare global {
  interface Window {
    vlmApi: VLMApi;
  }
}
```

## Data Models

### Shared Type Exports (`shared/index.ts`)

```typescript
// Errors
export { ErrorCode, ERROR_MESSAGES, getErrorMessage, ServiceError } from "./errors";

// IPC Types
export { IPCError, IPCResult, IPC_CHANNELS, IPCChannel, toIPCError } from "./ipc-types";

// VLM Types
export {
  VLMResponseSchema,
  VLMResponse,
  VLMAnalyzeRequest,
  VLMAnalyzeResponse,
  VLMStatusResponse,
  SUPPORTED_IMAGE_TYPES,
  SupportedImageType,
  MAX_IMAGE_SIZE,
} from "./vlm-types";
```

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

### Property 1: Singleton Invariant

_For any_ singleton service class (AISDKService, VLMService), multiple calls to getInstance() SHALL return the exact same object reference.

**Validates: Requirements 2.1, 3.1**

### Property 2: VLMResponse Schema Validation

_For any_ object, if it conforms to the VLMResponse structure (has title, description, objects array, optional text array, confidence 0-100), VLMResponseSchema.safeParse() SHALL return success: true. For any object that does not conform, it SHALL return success: false.

**Validates: Requirements 1.3, 4.1**

### Property 3: JSON Serialization Round-Trip

_For any_ valid IPCResult<T>, IPCError, or VLMResponse object, JSON.parse(JSON.stringify(obj)) SHALL produce an object deeply equal to the original.

**Validates: Requirements 1.4**

### Property 4: Error System Consistency

_For any_ ErrorCode value, getErrorMessage() SHALL return a non-empty user-friendly string. _For any_ ServiceError or Error, toIPCError() SHALL produce a valid IPCError with a code from ErrorCode enum.

**Validates: Requirements 4.1, 4.3, 4.4, 3.3**

### Property 5: Service Initialization Behavior

_For any_ AISDKConfig with empty or missing apiKey, initialize() SHALL throw ServiceError with API_KEY_MISSING code. _For any_ call to getClient() before initialization, it SHALL throw ServiceError with NOT_INITIALIZED code.

**Validates: Requirements 2.2, 2.3, 3.4**

## Error Handling

### Error Flow

```
Service Layer Error
       │
       ▼
┌──────────────────┐
│  ServiceError    │
│  - code: ErrorCode│
│  - message       │
│  - details?      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  toIPCError()    │
│  Convert to      │
│  IPCError        │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  IPCResult       │
│  success: false  │
│  error: IPCError │
└────────┬─────────┘
         │ IPC
         ▼
┌──────────────────┐
│  Frontend        │
│  getErrorMessage │
│  (error.code)    │
└──────────────────┘
```

## Testing Strategy

### Unit Tests

- ServiceError 类实例化测试
- getErrorMessage() 映射测试
- toIPCError() 转换测试

### Property-Based Tests (fast-check)

使用 `fast-check` 库进行属性测试，每个测试运行至少 100 次迭代：

1. **Singleton Property Test**: 验证多次 getInstance() 返回相同引用
2. **Schema Validation Property Test**: 生成随机对象验证 Zod schema
3. **JSON Round-Trip Property Test**: 验证所有类型的 JSON 序列化/反序列化
4. **Error Consistency Property Test**: 验证错误处理的一致性
5. **Initialization Property Test**: 验证初始化行为

每个属性测试必须使用以下格式标注：
`**Feature: ai-sdk-refactor, Property {number}: {property_text}**`

### Integration Tests

- 完整的 IPC 调用流程测试
- 前后端类型一致性验证

## File Structure

```
shared/                          # 前后端共享类型 (新增)
├── errors.ts                    # 错误码、ServiceError、getErrorMessage
├── ipc-types.ts                 # IPCResult、IPCError、IPC_CHANNELS、toIPCError
├── vlm-types.ts                 # VLMResponse schema、请求/响应类型
└── index.ts                     # 统一导出

electron/
├── main.ts                      # 主进程入口 (更新)
├── preload.ts                   # Preload 脚本 (更新)
├── services/
│   ├── ai-sdk-service.ts        # AISDKService 单例类 (重构)
│   ├── vlm-service.ts           # VLMService 单例类 (重构)
│   └── logger.ts                # 日志服务 (保留)
├── ipc/
│   ├── handler-registry.ts      # IPC 处理器注册表 (新增)
│   └── vlm-handlers.ts          # VLM IPC 处理器 (更新)
└── types/                       # 删除，移至 shared/

src/
├── pages/
│   └── VLMDemo.tsx              # Demo 页面 (更新，使用 shared 类型)
└── ...
```

## Dependencies

| Package                     | Version | Purpose                    |
| :-------------------------- | :------ | :------------------------- |
| `ai`                        | ^5.x    | Vercel AI SDK 核心包       |
| `@ai-sdk/openai-compatible` | ^1.x    | OpenAI Compatible Provider |
| `zod`                       | ^3.x    | Schema 验证                |
| `fast-check`                | ^3.x    | 属性测试                   |

## Migration Notes

1. 删除 `electron/types/vlm.ts`，类型移至 `shared/vlm-types.ts`
2. 将 `electron/services/ai-sdk.ts` 重构为 `AISDKService` 类
3. 将 `electron/services/vlm-service.ts` 重构为 `VLMService` 类
4. 更新所有导入路径使用 `@shared/` 别名
5. 前端组件更新为使用 `shared/` 中的类型和工具函数
