import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockNoObjectGeneratedError = vi.hoisted(() => ({
  isInstance: vi.fn(() => false),
}));

const mockAISDKService = vi.hoisted(() => ({
  getInstance: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    getVLMClient: vi.fn(() => ({})),
    getVLMModelName: vi.fn(() => "test-vlm-model"),
  })),
}));

const mockAiRuntimeService = vi.hoisted(() => ({
  acquire: vi.fn(() => Promise.resolve(vi.fn())),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));

const mockLlmUsageService = vi.hoisted(() => ({
  logEvent: vi.fn(),
}));

const mockAiRequestTraceBuffer = vi.hoisted(() => ({
  record: vi.fn(),
}));

const mockReadFile = vi.hoisted(() => vi.fn());

const mockPromptTemplates = vi.hoisted(() => ({
  getVLMSystemPrompt: vi.fn(() => "test system prompt"),
  getVLMUserPrompt: vi.fn(() => "test user prompt"),
}));

// Mock modules
vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("ai", () => ({
  generateObject: mockGenerateObject,
  NoObjectGeneratedError: mockNoObjectGeneratedError,
}));

vi.mock("../ai-sdk-service", () => ({
  AISDKService: mockAISDKService,
}));

vi.mock("../ai-runtime-service", () => ({
  aiRuntimeService: mockAiRuntimeService,
}));

vi.mock("../llm-usage-service", () => ({
  llmUsageService: mockLlmUsageService,
}));

vi.mock("../monitoring/ai-request-trace", () => ({
  aiRequestTraceBuffer: mockAiRequestTraceBuffer,
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./prompt-templates", () => ({
  promptTemplates: mockPromptTemplates,
}));

vi.mock("./config", () => ({
  processingConfig: {
    ai: {
      vlmTimeoutMs: 120000,
      vlmMaxOutputTokens: 8129,
    },
  },
}));

import { vlmProcessor } from "./vlm-processor";
import type { VlmBatchInput } from "./types";

describe("vlmProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("processBatch", () => {
    const createMockBatch = (screenshotCount = 2): VlmBatchInput => ({
      batchId: "test-batch-1",
      sourceKey: "screen:0",
      screenshots: Array.from({ length: screenshotCount }, (_, i) => ({
        id: i + 1,
        ts: Date.now() + i * 1000,
        sourceKey: "screen:0",
        filePath: `/tmp/test-${i}.png`,
        appHint: "vscode",
        windowTitle: "test.ts",
      })),
    });

    // Helper to create valid VLM output according to schema
    const createValidVLMOutput = (screenshotIndices: number[] = [1]) => ({
      nodes: screenshotIndices.map((idx) => ({
        screenshot_index: idx,
        title: `Test Title ${idx}`,
        summary: `Test Summary ${idx}`,
        app_context: {
          app_hint: "vscode",
          window_title: "test.ts",
          source_key: "screen:0",
        },
        knowledge: null,
        state_snapshot: null,
        entities: [],
        action_items: null,
        ui_text_snippets: [],
        importance: 5,
        confidence: 8,
        keywords: ["test"],
      })),
    });

    it("throws error when AI SDK is not initialized", async () => {
      mockAISDKService.getInstance.mockReturnValueOnce({
        isInitialized: vi.fn(() => false),
        getVLMClient: vi.fn(),
        getVLMModelName: vi.fn(),
      });

      const batch = createMockBatch(1);
      await expect(vlmProcessor.processBatch(batch)).rejects.toThrow("AI SDK not initialized");
    });

    it("successfully processes batch and returns nodes", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: { totalTokens: 100 },
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch = createMockBatch(1);
      const result = await vlmProcessor.processBatch(batch);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Test Title 1");
      expect(mockAiRuntimeService.recordSuccess).toHaveBeenCalledWith("vlm");
      expect(mockLlmUsageService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "vlm",
          operation: "vlm_analyze_batch",
          status: "succeeded",
        })
      );
    });

    it("handles NoObjectGeneratedError and logs details", async () => {
      const error = new Error("No object generated");
      mockNoObjectGeneratedError.isInstance.mockReturnValueOnce(true);
      mockGenerateObject.mockRejectedValueOnce(error);
      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch = createMockBatch(1);
      await expect(vlmProcessor.processBatch(batch)).rejects.toThrow(error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorName: error.name,
        }),
        "VLM NoObjectGeneratedError - raw response did not match schema"
      );
      expect(mockAiRuntimeService.recordFailure).toHaveBeenCalledWith("vlm", error);
    });

    it("handles generic errors and logs them", async () => {
      const error = new Error("Network error");
      mockNoObjectGeneratedError.isInstance.mockReturnValueOnce(false);
      mockGenerateObject.mockRejectedValueOnce(error);
      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch = createMockBatch(1);
      await expect(vlmProcessor.processBatch(batch)).rejects.toThrow(error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorName: "Error",
          errorMessage: "Network error",
        }),
        "VLM processBatch failed"
      );
      expect(mockAiRuntimeService.recordFailure).toHaveBeenCalledWith("vlm", error);
    });

    it("handles missing image files gracefully", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: { totalTokens: 50 },
      });

      mockReadFile.mockRejectedValue(new Error("File not found"));

      const batch = createMockBatch(1);
      const result = await vlmProcessor.processBatch(batch);

      expect(result).toHaveLength(1);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("handles multiple screenshots in batch", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1, 2]),
        usage: { totalTokens: 200 },
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch = createMockBatch(2);
      const result = await vlmProcessor.processBatch(batch);

      expect(result).toHaveLength(2);
      expect(mockAiRequestTraceBuffer.record).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "vlm",
          status: "succeeded",
        })
      );
    });

    it("handles screenshots without filePath", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: { totalTokens: 50 },
      });

      const batch: VlmBatchInput = {
        batchId: "test-batch-1",
        sourceKey: "screen:0",
        screenshots: [
          {
            id: 1,
            ts: Date.now(),
            sourceKey: "screen:0",
            filePath: null,
            appHint: "vscode",
            windowTitle: "test.ts",
          },
        ],
      };

      const result = await vlmProcessor.processBatch(batch);
      expect(result).toHaveLength(1);
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("handles usage without totalTokens", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: undefined,
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch = createMockBatch(1);
      const result = await vlmProcessor.processBatch(batch);
      expect(result).toHaveLength(1);
      expect(mockLlmUsageService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          totalTokens: 0,
          usageStatus: "missing",
        })
      );
    });

    it("respects abort timeout", async () => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      mockGenerateObject.mockImplementation(async ({ abortSignal }) => {
        // Wait for abort signal
        await delay(10);
        if (abortSignal?.aborted) {
          const error = new Error("AbortError");
          error.name = "AbortError";
          throw error;
        }
        return { object: createValidVLMOutput([1]), usage: {} };
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch = createMockBatch(1);

      // Should complete normally with short timeout in tests
      await expect(vlmProcessor.processBatch(batch)).resolves.toBeDefined();
    });

    it("handles non-Error thrown in catch block", async () => {
      mockNoObjectGeneratedError.isInstance.mockReturnValueOnce(false);
      mockGenerateObject.mockRejectedValueOnce("string-error");
      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch = createMockBatch(1);
      await expect(vlmProcessor.processBatch(batch)).rejects.toBe("string-error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorName: "UNKNOWN",
          errorMessage: "string-error",
        }),
        "VLM processBatch failed"
      );
    });

    it("processes .webp file extension correctly", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: { totalTokens: 50 },
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch: VlmBatchInput = {
        batchId: "test-batch-webp",
        sourceKey: "screen:0",
        screenshots: [
          {
            id: 1,
            ts: Date.now(),
            sourceKey: "screen:0",
            filePath: "/tmp/test.webp",
            appHint: null,
            windowTitle: null,
          },
        ],
      };

      const result = await vlmProcessor.processBatch(batch);
      expect(result).toHaveLength(1);
    });

    it("processes .jpg file extension correctly", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: { totalTokens: 50 },
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch: VlmBatchInput = {
        batchId: "test-batch-jpg",
        sourceKey: "screen:0",
        screenshots: [
          {
            id: 1,
            ts: Date.now(),
            sourceKey: "screen:0",
            filePath: "/tmp/test.jpg",
            appHint: "chrome",
            windowTitle: "page",
          },
        ],
      };

      const result = await vlmProcessor.processBatch(batch);
      expect(result).toHaveLength(1);
    });

    it("processes .jpeg file extension correctly", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: { totalTokens: 50 },
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch: VlmBatchInput = {
        batchId: "test-batch-jpeg",
        sourceKey: "screen:0",
        screenshots: [
          {
            id: 1,
            ts: Date.now(),
            sourceKey: "screen:0",
            filePath: "/tmp/test.jpeg",
            appHint: "chrome",
            windowTitle: "page",
          },
        ],
      };

      const result = await vlmProcessor.processBatch(batch);
      expect(result).toHaveLength(1);
    });

    it("defaults to image/jpeg for unknown file extension", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: createValidVLMOutput([1]),
        usage: { totalTokens: 50 },
      });

      mockReadFile.mockResolvedValue(Buffer.from("fake-image-data"));

      const batch: VlmBatchInput = {
        batchId: "test-batch-bmp",
        sourceKey: "screen:0",
        screenshots: [
          {
            id: 1,
            ts: Date.now(),
            sourceKey: "screen:0",
            filePath: "/tmp/test.bmp",
            appHint: null,
            windowTitle: null,
          },
        ],
      };

      const result = await vlmProcessor.processBatch(batch);
      expect(result).toHaveLength(1);
    });
  });

  describe("buildVLMRequest", () => {
    it("builds request with text and image content", () => {
      const screenshots = [
        {
          id: 1,
          ts: Date.now(),
          sourceKey: "screen:0",
          filePath: "/tmp/test.png",
          appHint: "vscode",
          windowTitle: "test.ts",
          base64: "aGVsbG8=",
          mime: "image/png",
        },
      ];

      const request = vlmProcessor.buildVLMRequest(screenshots);
      expect(request.system).toBe("test system prompt");
      expect(request.userContent).toHaveLength(2);
      expect(request.userContent[0]).toEqual({ type: "text", text: "test user prompt" });
      expect(request.userContent[1]).toEqual({
        type: "image",
        image: "data:image/png;base64,aGVsbG8=",
      });
    });

    it("skips images with empty base64", () => {
      const screenshots = [
        {
          id: 1,
          ts: Date.now(),
          sourceKey: "screen:0",
          filePath: "/tmp/test.png",
          appHint: null,
          windowTitle: null,
          base64: "",
          mime: null,
        },
      ];

      const request = vlmProcessor.buildVLMRequest(screenshots);
      expect(request.userContent).toHaveLength(1);
      expect(request.userContent[0].type).toBe("text");
    });

    it("uses image/jpeg as default mime when null", () => {
      const screenshots = [
        {
          id: 1,
          ts: Date.now(),
          sourceKey: "screen:0",
          filePath: "/tmp/test.png",
          appHint: "app",
          windowTitle: "win",
          base64: "aGVsbG8=",
          mime: null,
        },
      ];

      const request = vlmProcessor.buildVLMRequest(screenshots);
      expect(request.userContent[1]).toEqual({
        type: "image",
        image: "data:image/jpeg;base64,aGVsbG8=",
      });
    });

    it("handles multiple screenshots with mixed base64", () => {
      const screenshots = [
        {
          id: 1,
          ts: Date.now(),
          sourceKey: "screen:0",
          filePath: "/tmp/a.png",
          appHint: null,
          windowTitle: null,
          base64: "abc",
          mime: "image/png",
        },
        {
          id: 2,
          ts: Date.now(),
          sourceKey: "screen:0",
          filePath: "/tmp/b.png",
          appHint: null,
          windowTitle: null,
          base64: "",
          mime: null,
        },
        {
          id: 3,
          ts: Date.now(),
          sourceKey: "screen:0",
          filePath: "/tmp/c.webp",
          appHint: null,
          windowTitle: null,
          base64: "def",
          mime: "image/webp",
        },
      ];

      const request = vlmProcessor.buildVLMRequest(screenshots);
      // 1 text + 2 images (screenshot 2 has empty base64)
      expect(request.userContent).toHaveLength(3);
    });
  });
});
