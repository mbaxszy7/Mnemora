# Design Document: AI SDK 5.x Integration

## Overview

本设计文档描述了在 Mnemora Electron 应用中集成 Vercel AI SDK 5.x 的技术方案。核心目标是实现一个 Demo：用户选择图片 → 调用 VLM 分析 → 展示结果。

架构采用 Electron 主进程直接调用 AI SDK，渲染进程通过 IPC 通信触发操作，无需创建本地 HTTP server。

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Renderer Process (React)                     │
│  ┌─────────────────┐    ┌─────────────────┐                     │
│  │   Demo Page     │    │   IPC Client    │                     │
│  │  - Image Select │───▶│  - invoke()     │                     │
│  │  - Preview      │    │  - on()         │                     │
│  │  - Result View  │◀───│                 │                     │
│  └─────────────────┘    └────────┬────────┘                     │
└──────────────────────────────────┼──────────────────────────────┘
                                   │ IPC
┌──────────────────────────────────┼──────────────────────────────┐
│                     Main Process (Node.js)                       │
│                      ┌───────────┴───────────┐                  │
│                      │     IPC Handler       │                  │
│                      │  - handle('vlm:*')    │                  │
│                      └───────────┬───────────┘                  │
│                                  │                               │
│  ┌─────────────────┐    ┌───────┴───────┐    ┌───────────────┐ │
│  │  AI SDK Module  │◀───│  VLM Service  │───▶│ Zod Validator │ │
│  │  - openai()     │    │  - analyze()  │    │ - parse()     │ │
│  │  - anthropic()  │    │               │    │ - safeParse() │ │
│  └─────────────────┘    └───────────────┘    └───────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                          ┌───────────────┐
                          │  OpenAI API   │
                          │  (GPT-4o)     │
                          └───────────────┘
```

## Components and Interfaces

### 1. AI SDK Module (`electron/services/ai-sdk.ts`)

负责初始化 AI SDK 并提供 VLM 调用能力。

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';

interface AISDKConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

interface AISDKModule {
  initialize(config: AISDKConfig): void;
  isInitialized(): boolean;
  getClient(): ReturnType<typeof createOpenAI>;
}
```

### 2. VLM Service (`electron/services/vlm-service.ts`)

封装 VLM 调用逻辑，处理图片分析。

```typescript
import { z } from 'zod';

// VLM 响应 Schema
const VLMResponseSchema = z.object({
  title: z.string().describe('图片内容的简短标题'),
  description: z.string().describe('图片内容的详细描述'),
  objects: z.array(z.string()).describe('图片中识别到的物体列表'),
  text: z.string().optional().describe('图片中识别到的文字'),
  confidence: z.number().min(0).max(100).describe('分析置信度'),
});

type VLMResponse = z.infer<typeof VLMResponseSchema>;

interface VLMService {
  analyzeImage(imageBuffer: Buffer, mimeType: string): Promise<VLMResponse>;
}
```

### 3. IPC Bridge (`electron/ipc/vlm-handlers.ts`)

处理渲染进程与主进程之间的 VLM 相关通信。

```typescript
// IPC Channel 定义
const VLM_CHANNELS = {
  ANALYZE: 'vlm:analyze',
  STATUS: 'vlm:status',
} as const;

// IPC 请求/响应类型
interface VLMAnalyzeRequest {
  imageData: string; // base64 encoded
  mimeType: string;
}

interface VLMAnalyzeResponse {
  success: boolean;
  data?: VLMResponse;
  error?: {
    code: string;
    message: string;
  };
}
```

### 4. Preload Script (`electron/preload.ts`)

暴露安全的 IPC 接口给渲染进程。

```typescript
interface VLMApi {
  analyze(imageData: string, mimeType: string): Promise<VLMAnalyzeResponse>;
  getStatus(): Promise<{ initialized: boolean; model: string }>;
}

// 通过 contextBridge 暴露
declare global {
  interface Window {
    vlmApi: VLMApi;
  }
}
```

### 5. Demo Page (`src/pages/VLMDemo.tsx`)

React 组件，提供图片选择和结果展示 UI。

```typescript
interface DemoState {
  selectedImage: File | null;
  imagePreview: string | null;
  isAnalyzing: boolean;
  result: VLMResponse | null;
  error: string | null;
}
```

## Data Models

### VLM Response Schema

```typescript
import { z } from 'zod';

export const VLMResponseSchema = z.object({
  title: z.string(),
  description: z.string(),
  objects: z.array(z.string()),
  text: z.string().optional(),
  confidence: z.number().min(0).max(100),
});

export type VLMResponse = z.infer<typeof VLMResponseSchema>;
```

### IPC Message Types

```typescript
export interface IPCError {
  code: 'API_KEY_MISSING' | 'VLM_ERROR' | 'VALIDATION_ERROR' | 'UNKNOWN';
  message: string;
  details?: unknown;
}

export interface IPCResult<T> {
  success: boolean;
  data?: T;
  error?: IPCError;
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: API Key Initialization Consistency

*For any* valid API key string, initializing the AI SDK module should result in `isInitialized()` returning true, and for any empty or undefined API key, initialization should fail with a clear error.

**Validates: Requirements 1.1, 1.2**

### Property 2: IPC Data Integrity

*For any* valid image buffer sent via IPC, the data received by the main process should be identical to the data sent, and any response or error should be forwarded back to the renderer unchanged.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 3: Zod Validation Round-Trip

*For any* object that conforms to the VLMResponseSchema, `safeParse()` should return `success: true` with the typed data. For any object that does not conform, `safeParse()` should return `success: false` with error details.

**Validates: Requirements 4.1, 4.2, 4.3**

### Property 4: Image Preview Rendering

*For any* valid image file (JPEG, PNG, WebP), selecting it should result in a preview being displayed in the UI.

**Validates: Requirements 3.2**

### Property 5: Error Message Display

*For any* error returned from the VLM service, the Demo page should display a user-friendly message (not raw error objects or stack traces).

**Validates: Requirements 3.5**

## Error Handling

### Error Types

| Error Code | Cause | User Message |
|:-----------|:------|:-------------|
| `API_KEY_MISSING` | 环境变量未设置 | "请配置 OpenAI API Key" |
| `VLM_ERROR` | API 调用失败 | "图片分析失败，请重试" |
| `VALIDATION_ERROR` | 响应格式错误 | "响应格式异常" |
| `IMAGE_TOO_LARGE` | 图片超过限制 | "图片过大，请选择小于 20MB 的图片" |

### Error Flow

```
VLM Service Error
       │
       ▼
┌──────────────┐
│ Catch Error  │
│ - Log detail │
│ - Map to code│
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ IPC Response │
│ success:false│
│ error: {...} │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ UI Display   │
│ User-friendly│
│ message      │
└──────────────┘
```

## Testing Strategy

### Unit Tests

- AI SDK Module 初始化测试
- Zod Schema 验证测试
- IPC Handler 测试

### Property-Based Tests (fast-check)

使用 `fast-check` 库进行属性测试，验证核心正确性属性：

1. **Zod Validation Property Test**: 生成随机对象，验证 schema 验证的一致性
2. **IPC Serialization Property Test**: 生成随机 buffer，验证序列化/反序列化的完整性

```typescript
import fc from 'fast-check';
import { VLMResponseSchema } from './schemas';

// Property: Valid objects always pass validation
fc.assert(
  fc.property(
    fc.record({
      title: fc.string({ minLength: 1 }),
      description: fc.string(),
      objects: fc.array(fc.string()),
      text: fc.option(fc.string()),
      confidence: fc.integer({ min: 0, max: 100 }),
    }),
    (obj) => {
      const result = VLMResponseSchema.safeParse(obj);
      return result.success === true;
    }
  )
);
```

### Integration Tests

- 完整的图片选择 → VLM 调用 → 结果展示流程测试

## Dependencies

| Package | Version | Purpose |
|:--------|:--------|:--------|
| `ai` | ^5.x | Vercel AI SDK 核心包 |
| `@ai-sdk/openai` | ^1.x | OpenAI Provider |
| `zod` | ^4.x | Schema 验证（已安装） |
| `fast-check` | ^3.x | 属性测试 |

## File Structure

```
electron/
├── main.ts                    # 主进程入口（更新）
├── preload.ts                 # Preload 脚本（更新）
├── services/
│   ├── ai-sdk.ts              # AI SDK 模块（新增）
│   └── vlm-service.ts         # VLM 服务（新增）
├── ipc/
│   └── vlm-handlers.ts        # IPC 处理器（新增）
└── types/
    └── vlm.ts                 # 类型定义（新增）

src/
├── pages/
│   ├── VLMDemo.tsx            # Demo 页面（新增）
│   └── index.ts               # 导出更新
└── router/
    └── index.tsx              # 路由更新
```
