# Requirements Document

## Introduction

本文档定义了在 Mnemora 桌面应用中集成 Vercel AI SDK 5.x 的需求。目标是实现一个简单的 Demo：用户选择图片，调用 VLM（Vision Language Model）分析图片内容，前端展示响应结果。采用 Electron 主进程直接调用的架构，通过 IPC 与渲染进程通信。

## Glossary

- **AI SDK**: Vercel 开发的 AI 开发工具包（`ai` npm package），提供统一的 LLM 调用接口
- **VLM**: Vision Language Model，视觉语言模型，用于分析图片内容
- **IPC**: Inter-Process Communication，Electron 进程间通信机制
- **Main Process**: Electron 主进程，运行 Node.js 环境
- **Renderer Process**: Electron 渲染进程，运行 React 应用
- **Zod**: TypeScript-first schema 验证库，用于结构化输出验证
- **fast-check**: 属性测试库，用于生成测试用例验证代码正确性

## Requirements

### Requirement 1

**User Story:** As a developer, I want to integrate AI SDK 5.x into the Electron main process, so that I can call VLM APIs directly.

#### Acceptance Criteria

1. WHEN the application starts THEN the AI_SDK_Module SHALL initialize with API key from environment variables
2. WHEN an API key is missing THEN the AI_SDK_Module SHALL report a clear error message
3. WHEN the AI SDK is initialized THEN the AI_SDK_Module SHALL expose a function to call VLM with image input

### Requirement 2

**User Story:** As a developer, I want to call VLM from the renderer process via IPC, so that React components can trigger image analysis.

#### Acceptance Criteria

1. WHEN the renderer process sends an image buffer via IPC THEN the IPC_Bridge SHALL forward it to the AI SDK in main process
2. WHEN the VLM returns a response THEN the IPC_Bridge SHALL send the result back to the renderer process
3. WHEN an error occurs THEN the IPC_Bridge SHALL serialize and forward the error to the renderer

### Requirement 3

**User Story:** As a user, I want to select an image and see VLM analysis results, so that I can verify the AI SDK integration works.

#### Acceptance Criteria

1. WHEN the user clicks the image select button THEN the Demo_Page SHALL open a file picker for image files
2. WHEN an image is selected THEN the Demo_Page SHALL display a preview of the image
3. WHEN the user clicks analyze THEN the Demo_Page SHALL send the image to VLM and show a loading state
4. WHEN the VLM response is received THEN the Demo_Page SHALL display the analysis result
5. WHEN an error occurs THEN the Demo_Page SHALL display a user-friendly error message

### Requirement 4

**User Story:** As a developer, I want VLM responses to be validated with Zod schemas, so that I can ensure type-safe structured output.

#### Acceptance Criteria

1. WHEN the VLM returns a response THEN the Validation_Service SHALL validate it against a Zod schema
2. WHEN validation fails THEN the Validation_Service SHALL return a typed error with details
3. WHEN validation succeeds THEN the Validation_Service SHALL return the typed response object
