# Implementation Plan

- [x] 1. Set up shared types module
  - [x] 1.1 Create shared directory and configure path alias
    - Create `shared/` directory at project root
    - Update `tsconfig.json` to add `@shared/*` path alias
    - Update `vite.config.ts` to resolve the alias for renderer process
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Implement error types (`shared/errors.ts`)
    - Create ErrorCode enum with all error codes
    - Create ERROR_MESSAGES mapping
    - Implement getErrorMessage() utility function
    - Implement ServiceError class extending Error
    - _Requirements: 1.1, 4.1, 4.2, 4.4_

  - [x] 1.3 Write property test for error system consistency
    - **Property 4: Error System Consistency**
    - **Validates: Requirements 4.1, 4.3, 4.4, 3.3**

  - [x] 1.4 Implement IPC types (`shared/ipc-types.ts`)
    - Create IPCError interface
    - Create IPCResult<T> generic interface
    - Create IPC_CHANNELS constant object
    - Implement toIPCError() utility function
    - _Requirements: 1.2, 4.3_

  - [x] 1.5 Write property test for JSON serialization round-trip
    - **Property 3: JSON Serialization Round-Trip**
    - **Validates: Requirements 1.4**

  - [x] 1.6 Implement VLM types (`shared/vlm-types.ts`)
    - Create VLMResponseSchema with Zod
    - Create VLMAnalyzeRequest, VLMAnalyzeResponse types
    - Create VLMStatusResponse type
    - Define SUPPORTED_IMAGE_TYPES and MAX_IMAGE_SIZE constants
    - _Requirements: 1.3, 4.1_

  - [x] 1.7 Write property test for VLMResponse schema validation
    - **Property 2: VLMResponse Schema Validation**
    - **Validates: Requirements 1.3, 4.1**

  - [x] 1.8 Create shared module index (`shared/index.ts`)
    - Export all types, interfaces, and utilities
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Checkpoint - Ensure shared types compile correctly
  - Ensure all tests pass, ask the user if questions arise.

-

- [x] 3. Implement AISDKService singleton
  - [x] 3.1 Create AISDKService class (`electron/services/ai-sdk-service.ts`)
    - Implement private constructor
    - Implement static getInstance() method
    - Implement static resetInstance() for testing
    - Implement initialize() with config validation
    - Implement isInitialized() and getClient() methods
    - Use ServiceError from shared module
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.2 Write property test for singleton invariant (AISDKService)
    - **Property 1: Singleton Invariant (AISDKService)**
    - **Validates: Requirements 2.1**

  - [ ] 3.3 Write property test for service initialization behavior
    - **Property 5: Service Initialization Behavior**
    - **Validates: Requirements 2.2, 2.3, 3.4**

- [x] 4. Implement VLMService singleton
  - [x] 4.1 Create VLMService class (`electron/services/vlm-service.ts`)
    - Implement private constructor with AISDKService dependency
    - Implement static getInstance() method
    - Implement static resetInstance() for testing
    - Implement analyzeImage() with validation
    - Implement analyzeImageFromBase64() convenience method
    - Use shared types and toIPCError()
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Write property test for singleton invariant (VLMService)
    - **Property 1: Singleton Invariant (VLMService)**
    - **Validates: Requirements 3.1**

- [x] 5. Implement IPC layer
  - [x] 5.1 Create IPCHandlerRegistry (`electron/ipc/handler-registry.ts`)
    - Implement singleton pattern
    - Implement registerHandler() with type safety
    - Implement isRegistered() check
    - _Requirements: 6.1, 6.2_

  - [x] 5.2 Update VLM handlers (`electron/ipc/vlm-handlers.ts`)
    - Use IPCHandlerRegistry for registration
    - Use VLMService singleton
    - Use shared IPC_CHANNELS constants
    - _Requirements: 6.2, 6.4_

  - [x] 5.3 Update preload script (`electron/preload.ts`)
    - Import types from shared module
    - Use IPC_CHANNELS constants
    - Export typed VLMApi interface
    - _Requirements: 5.1, 5.2, 6.3_

  - [x] 5.4 Update main process (`electron/main.ts`)
    - Use AISDKService.getInstance() for initialization
    - Register handlers via IPCHandlerRegistry
    - _Requirements: 2.1, 6.1_

- [x] 6. Checkpoint - Ensure backend compiles and services work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Update frontend to use shared types
  - [x] 7.1 Update VLMDemo page (`src/pages/VLMDemo.tsx`)
    - Import types from shared module
    - Use getErrorMessage() from shared
    - Use SUPPORTED_IMAGE_TYPES for validation
    - Remove duplicate type definitions
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 8. Cleanup and migration
  - [x] 8.1 Remove deprecated files
    - Delete `electron/types/vlm.ts` (moved to shared)
    - Delete old `electron/services/ai-sdk.ts` (replaced by ai-sdk-service.ts)
    - _Requirements: 1.1_

  - [x] 8.2 Update any remaining imports
    - Ensure all files use @shared/ imports
    - Fix any TypeScript errors
    - _Requirements: 5.1_

- [ ] 9. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
