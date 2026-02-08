import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockCreateWorker = vi.hoisted(() => vi.fn());

const mockTesseract = vi.hoisted(() => ({
  createWorker: mockCreateWorker,
}));

const mockSharp = vi.hoisted(() =>
  vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
    extract: vi.fn().mockReturnThis(),
    greyscale: vi.fn().mockReturnThis(),
    normalize: vi.fn().mockReturnThis(),
    sharpen: vi.fn().mockReturnThis(),
    linear: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("processed-image")),
  }))
);

// Mock modules
vi.mock("tesseract.js", () => mockTesseract);

vi.mock("sharp", () => ({
  default: mockSharp,
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./config", () => ({
  processingConfig: {
    ocr: {
      maxChars: 8000,
      languages: "eng+chi_sim",
      concurrency: 2,
    },
  },
}));

import { OcrService } from "./ocr-service";
import type { KnowledgePayload } from "./types";

describe("OcrService", () => {
  let service: OcrService;
  let mockWorker: {
    recognize: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorker = {
      recognize: vi.fn().mockResolvedValue({
        data: {
          text: "Extracted text content",
          confidence: 95,
        },
      }),
      terminate: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateWorker.mockResolvedValue(mockWorker);

    service = new OcrService();
  });

  describe("warmup", () => {
    it("creates a worker and releases it", async () => {
      await service.warmup();

      expect(mockCreateWorker).toHaveBeenCalledWith("eng+chi_sim", 1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("handles warmup failure gracefully", async () => {
      mockCreateWorker.mockRejectedValueOnce(new Error("Failed to create worker"));

      await service.warmup();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
        }),
        "Failed to warm up OCR worker"
      );
    });
  });

  describe("recognize", () => {
    it("extracts text from image", async () => {
      const result = await service.recognize({ filePath: "/tmp/test.png" });

      expect(result.text).toBe("Extracted text content");
      expect(result.confidence).toBe(95);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.preprocessMs).toBeGreaterThanOrEqual(0);
      expect(result.recognizeMs).toBeGreaterThanOrEqual(0);
    });

    it("truncates text to maxChars", async () => {
      const longText = "a".repeat(10000);
      mockWorker.recognize.mockResolvedValueOnce({
        data: {
          text: longText,
          confidence: 90,
        },
      });

      const result = await service.recognize({ filePath: "/tmp/test.png" });

      expect(result.text.length).toBeLessThanOrEqual(8000);
    });

    it("handles text region cropping", async () => {
      const mockExtract = vi.fn().mockReturnThis();
      const mockMetadata = vi.fn().mockResolvedValue({ width: 1920, height: 1080 });

      // Reset mock and set up chain for this specific test
      mockSharp.mockImplementation(() => ({
        metadata: mockMetadata,
        extract: mockExtract,
        greyscale: vi.fn().mockReturnThis(),
        normalize: vi.fn().mockReturnThis(),
        sharpen: vi.fn().mockReturnThis(),
        linear: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from("processed-image")),
      }));

      const textRegion: NonNullable<KnowledgePayload["textRegion"]> = {
        box: { top: 100, left: 100, width: 500, height: 300 },
        description: "Code area",
        confidence: 0.9,
      };

      const result = await service.recognize({
        filePath: "/tmp/test.png",
        textRegion,
      });

      // Verify the recognize was called and returned valid result
      expect(result.text).toBe("Extracted text content");
      expect(result.confidence).toBe(95);
    });

    it("handles missing image metadata gracefully", async () => {
      mockSharp.mockReturnValueOnce({
        metadata: vi.fn().mockResolvedValue({ width: 0, height: 0 }),
        extract: vi.fn().mockReturnThis(),
        greyscale: vi.fn().mockReturnThis(),
        normalize: vi.fn().mockReturnThis(),
        sharpen: vi.fn().mockReturnThis(),
        linear: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from("processed")),
      });

      const textRegion: NonNullable<KnowledgePayload["textRegion"]> = {
        box: { top: 0, left: 0, width: 100, height: 100 },
      };

      const result = await service.recognize({
        filePath: "/tmp/test.png",
        textRegion,
      });

      expect(result.text).toBe("Extracted text content");
    });

    it("handles worker termination on dispose", async () => {
      // Create a worker first
      await service.warmup();
      await service.dispose();

      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it("handles dispose with no workers", async () => {
      await service.dispose();
      // Should not throw
      expect(mockWorker.terminate).not.toHaveBeenCalled();
    });

    it("handles worker termination errors gracefully", async () => {
      mockWorker.terminate.mockRejectedValueOnce(new Error("Termination failed"));

      await service.warmup();
      await service.dispose();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
        }),
        "Failed to terminate OCR worker"
      );
    });

    it("reuses workers when available", async () => {
      // First call creates worker
      await service.recognize({ filePath: "/tmp/test1.png" });
      expect(mockCreateWorker).toHaveBeenCalledTimes(1);

      // Second call should reuse the same worker
      await service.recognize({ filePath: "/tmp/test2.png" });
      expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    });

    it("creates new worker when max not reached and all busy", async () => {
      // Set concurrency to 2 so we can create 2 workers
      // First warmup creates 1 worker
      await service.warmup();
      expect(mockCreateWorker).toHaveBeenCalledTimes(1);

      // Start first recognize call (uses existing worker)
      const firstPromise = service.recognize({ filePath: "/tmp/test1.png" });

      // Start second recognize call - should create second worker since max not reached
      // and first worker is busy
      const secondPromise = service.recognize({ filePath: "/tmp/test2.png" });

      await Promise.all([firstPromise, secondPromise]);

      // Should have created second worker
      expect(mockCreateWorker).toHaveBeenCalledTimes(2);
    });

    it("handles zero dimensions in text region", async () => {
      mockSharp.mockReturnValueOnce({
        metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        extract: vi.fn().mockReturnThis(),
        greyscale: vi.fn().mockReturnThis(),
        normalize: vi.fn().mockReturnThis(),
        sharpen: vi.fn().mockReturnThis(),
        linear: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from("processed")),
      });

      const textRegion: NonNullable<KnowledgePayload["textRegion"]> = {
        box: { top: 0, left: 0, width: 0, height: 0 }, // Zero dimensions
      };

      const result = await service.recognize({
        filePath: "/tmp/test.png",
        textRegion,
      });

      expect(result.text).toBe("Extracted text content");
    });

    it("handles negative dimensions from clamping", async () => {
      mockSharp.mockReturnValueOnce({
        metadata: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
        extract: vi.fn().mockReturnThis(),
        greyscale: vi.fn().mockReturnThis(),
        normalize: vi.fn().mockReturnThis(),
        sharpen: vi.fn().mockReturnThis(),
        linear: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from("processed")),
      });

      const textRegion: NonNullable<KnowledgePayload["textRegion"]> = {
        box: { top: 50, left: 50, width: 200, height: 200 }, // Exceeds image size
      };

      const result = await service.recognize({
        filePath: "/tmp/test.png",
        textRegion,
      });

      expect(result.text).toBe("Extracted text content");
    });

    it("handles recognize errors", async () => {
      mockWorker.recognize.mockRejectedValueOnce(new Error("Recognition failed"));

      await expect(service.recognize({ filePath: "/tmp/test.png" })).rejects.toThrow(
        "Recognition failed"
      );
    });

    it("trims whitespace from extracted text", async () => {
      mockWorker.recognize.mockResolvedValueOnce({
        data: {
          text: "  \n  Text with whitespace  \n  ",
          confidence: 85,
        },
      });

      const result = await service.recognize({ filePath: "/tmp/test.png" });

      expect(result.text).toBe("Text with whitespace");
    });
  });
});
