# Requirements Document

## Introduction

本文档定义了对 Mnemora 桌面应用中 AI SDK 集成和 VLM 服务的重构需求。目标是建立一个高度可扩展、类型统一的架构，使用单例设计模式实现核心服务，并将前后端共享的类型定义集中管理。

## Glossary

- **AI SDK**: Vercel 开发的 AI 开发工具包（`ai` npm package），提供统一的 LLM 调用接口
- **VLM**: Vision Language Model，视觉语言模型，用于分析图片内容
- **IPC**: Inter-Process Communication，Electron 进程间通信机制
- **Singleton**: 单例设计模式，确保一个类只有一个实例
- **Shared Types**: 前后端共享的类型定义，存放在统一位置
- **Service Class**: 使用类封装的服务，提供更好的封装性和可扩展性
- **Error Code**: 统一的错误代码枚举，前后端共用

## Requirements

### Requirement 1

**User Story:** As a developer, I want all shared types (error codes, API responses, request payloads) to be defined in a single location, so that frontend and backend can import from the same source.

#### Acceptance Criteria

1. WHEN defining error codes THEN the Shared_Types_Module SHALL export a single ErrorCode enum used by both main process and renderer process
2. WHEN defining API response types THEN the Shared_Types_Module SHALL export generic IPCResult<T> and IPCError interfaces
3. WHEN defining VLM-specific types THEN the Shared_Types_Module SHALL export VLMResponse schema and related request/response types
4. WHEN serializing types for IPC THEN the Shared_Types_Module SHALL ensure all types are JSON-serializable

### Requirement 2

**User Story:** As a developer, I want the AI SDK service to be implemented as a singleton class, so that I can ensure only one instance exists and easily extend its functionality.

#### Acceptance Criteria

1. WHEN accessing the AI SDK service THEN the AISDKService class SHALL return the same instance via getInstance() method
2. WHEN initializing the AI SDK THEN the AISDKService class SHALL accept a configuration object with provider settings
3. WHEN the service is not initialized THEN the AISDKService class SHALL throw a typed error with NOT_INITIALIZED code
4. WHEN extending the service THEN the AISDKService class SHALL allow subclassing or composition for additional providers

### Requirement 3

**User Story:** As a developer, I want the VLM service to be implemented as a singleton class that depends on AISDKService, so that I can manage image analysis with proper dependency injection.

#### Acceptance Criteria

1. WHEN accessing the VLM service THEN the VLMService class SHALL return the same instance via getInstance() method
2. WHEN analyzing an image THEN the VLMService class SHALL use the AISDKService singleton for API calls
3. WHEN validation fails THEN the VLMService class SHALL return an error using the shared IPCError type
4. WHEN the image exceeds size limits THEN the VLMService class SHALL return IMAGE_TOO_LARGE error code

### Requirement 4

**User Story:** As a developer, I want a unified error handling system, so that errors are consistent across the entire application.

#### Acceptance Criteria

1. WHEN an error occurs in any service THEN the Error_System SHALL use the shared ErrorCode enum
2. WHEN creating service errors THEN the Error_System SHALL provide a ServiceError class that extends Error with code and details
3. WHEN converting errors for IPC THEN the Error_System SHALL provide a toIPCError() utility function
4. WHEN displaying errors in UI THEN the Error_System SHALL provide a getErrorMessage() utility that maps codes to user-friendly messages

### Requirement 5

**User Story:** As a developer, I want the frontend to use the same type definitions as the backend, so that I have full type safety across IPC boundaries.

#### Acceptance Criteria

1. WHEN importing types in renderer process THEN the Frontend_Types SHALL reference the shared types module
2. WHEN handling IPC responses THEN the Frontend_Types SHALL use the same IPCResult<T> generic type
3. WHEN displaying error messages THEN the Frontend_Types SHALL use the shared getErrorMessage() utility
4. WHEN validating responses THEN the Frontend_Types SHALL use the same Zod schemas as the backend

### Requirement 6

**User Story:** As a developer, I want the IPC layer to be type-safe and extensible, so that I can easily add new IPC channels with proper typing.

#### Acceptance Criteria

1. WHEN defining IPC channels THEN the IPC_Layer SHALL use a typed channel registry
2. WHEN registering handlers THEN the IPC_Layer SHALL enforce request/response type matching
3. WHEN invoking IPC from renderer THEN the IPC_Layer SHALL provide typed invoke methods
4. WHEN adding new channels THEN the IPC_Layer SHALL require only adding to the channel registry
