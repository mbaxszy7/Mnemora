import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockEmbed = vi.hoisted(() => vi.fn());

const mockAISDKService = vi.hoisted(() => ({
  getInstance: vi.fn(() => ({
    getEmbeddingClient: vi.fn(() => ({})),
    getEmbeddingModelName: vi.fn(() => "test-embedding-model"),
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

// Mock modules
vi.mock("ai", () => ({
  embed: mockEmbed,
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

vi.mock("./config", () => ({
  processingConfig: {
    ai: {
      embeddingTimeoutMs: 60000,
    },
  },
}));

import { EmbeddingService } from "./embedding-service";

describe("EmbeddingService", () => {
  let service: EmbeddingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EmbeddingService();
  });

  describe("embed", () => {
    it("generates embedding for text", async () => {
      const mockEmbedding = new Array(1024).fill(0.1);
      mockEmbed.mockResolvedValueOnce({
        embedding: mockEmbedding,
        usage: { tokens: 10 },
      });

      const result = await service.embed("test text");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(1024);
      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.any(Object),
          value: "test text",
          abortSignal: expect.any(AbortSignal),
          providerOptions: {
            mnemora: {
              dimensions: 1024,
            },
          },
        })
      );
    });

    it("logs usage event on success", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0.1),
        usage: { tokens: 25 },
      });

      await service.embed("test");

      expect(mockLlmUsageService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "embedding",
          operation: "embedding_node",
          status: "succeeded",
          model: "test-embedding-model",
          totalTokens: 25,
          usageStatus: "present",
        })
      );
    });

    it("handles missing usage information", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0.1),
        usage: undefined,
      });

      await service.embed("test");

      expect(mockLlmUsageService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          usageStatus: "missing",
        })
      );
    });

    it("records request trace on success", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0.1),
        usage: { tokens: 10 },
      });

      await service.embed("test");

      expect(mockAiRequestTraceBuffer.record).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "embedding",
          operation: "embedding_node",
          model: "test-embedding-model",
          status: "succeeded",
          responsePreview: "Embedding generated: 1024 dimensions",
        })
      );
    });

    it("records success in ai runtime service", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0.1),
        usage: { tokens: 10 },
      });

      await service.embed("test");

      expect(mockAiRuntimeService.recordSuccess).toHaveBeenCalledWith("embedding");
    });

    it("handles embedding errors", async () => {
      const error = new Error("Embedding failed");
      mockEmbed.mockRejectedValueOnce(error);

      await expect(service.embed("test")).rejects.toThrow("Embedding failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Embedding failed",
        }),
        "Failed to generate embedding"
      );
    });

    it("does not log usage event on error (only on success)", async () => {
      const error = new Error("API Error");
      mockEmbed.mockRejectedValueOnce(error);

      try {
        await service.embed("test");
      } catch {
        // expected
      }

      // Usage event is only logged on success, not on error
      expect(mockLlmUsageService.logEvent).not.toHaveBeenCalled();
    });

    it("records failure in ai runtime service", async () => {
      const error = new Error("Timeout");
      mockEmbed.mockRejectedValueOnce(error);

      await expect(service.embed("test")).rejects.toThrow();

      expect(mockAiRuntimeService.recordFailure).toHaveBeenCalledWith("embedding", error);
    });

    it("records request trace on failure", async () => {
      mockEmbed.mockRejectedValueOnce(new Error("Network error"));

      await expect(service.embed("test")).rejects.toThrow();

      expect(mockAiRequestTraceBuffer.record).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "embedding",
          operation: "embedding_node",
          model: "test-embedding-model",
          status: "failed",
          errorPreview: "Error: Network error",
        })
      );
    });

    it("respects external abort signal", async () => {
      const controller = new AbortController();
      mockEmbed.mockImplementation(async ({ abortSignal }) => {
        // Check that external signal is connected
        expect(abortSignal).toBeDefined();
        return {
          embedding: new Array(1024).fill(0.1),
          usage: { tokens: 10 },
        };
      });

      await service.embed("test", controller.signal);

      expect(mockEmbed).toHaveBeenCalled();
    });

    it("cleans up abort listener on success", async () => {
      const controller = new AbortController();
      const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");

      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0.1),
        usage: { tokens: 10 },
      });

      await service.embed("test", controller.signal);

      expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("cleans up abort listener on error", async () => {
      const controller = new AbortController();
      const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");

      mockEmbed.mockRejectedValueOnce(new Error("Failed"));

      await expect(service.embed("test", controller.signal)).rejects.toThrow();

      expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("releases semaphore after success", async () => {
      const mockRelease = vi.fn();
      mockAiRuntimeService.acquire.mockResolvedValueOnce(mockRelease);

      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0.1),
        usage: { tokens: 10 },
      });

      await service.embed("test");

      expect(mockRelease).toHaveBeenCalled();
    });

    it("releases semaphore after error", async () => {
      const mockRelease = vi.fn();
      mockAiRuntimeService.acquire.mockResolvedValueOnce(mockRelease);

      mockEmbed.mockRejectedValueOnce(new Error("Failed"));

      await expect(service.embed("test")).rejects.toThrow();

      expect(mockRelease).toHaveBeenCalled();
    });

    it("handles empty text", async () => {
      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0),
        usage: { tokens: 0 },
      });

      const result = await service.embed("");

      expect(result).toBeInstanceOf(Float32Array);
      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({
          value: "",
        })
      );
    });

    it("handles very long text", async () => {
      const longText = "a".repeat(100000);
      mockEmbed.mockResolvedValueOnce({
        embedding: new Array(1024).fill(0.1),
        usage: { tokens: 25000 },
      });

      const result = await service.embed(longText);

      expect(result).toBeInstanceOf(Float32Array);
    });
  });
});
