/**
 * Unit Tests for CaptureService
 *
 * These tests verify the CaptureService functionality including:
 * - Single monitor capture
 * - Error handling when monitor unavailable
 *
 * Requirements: 6.1, 6.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CaptureService, CaptureError } from "./capture-service";

// Mock electron screen module
vi.mock("electron", () => ({
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      {
        id: 2,
        bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      },
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  },
}));

// Mock node-screenshots
vi.mock("node-screenshots", () => {
  const mockImage = {
    width: 1920,
    height: 1080,
    toPng: vi.fn().mockResolvedValue(Buffer.from("mock-png-data")),
    toJpeg: vi.fn().mockResolvedValue(Buffer.from("mock-jpeg-data")),
  };

  const mockMonitor = {
    id: 0,
    name: "Display 0",
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    scaleFactor: 1,
    frequency: 60,
    isPrimary: true,
    captureImage: vi.fn().mockResolvedValue(mockImage),
  };

  return {
    Monitor: {
      all: vi.fn(() => [mockMonitor]),
      fromPoint: vi.fn(() => mockMonitor),
    },
    Image: vi.fn(),
  };
});

// Mock sharp
vi.mock("sharp", () => {
  const mockSharpInstance = {
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    composite: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("mock-output-data")),
  };

  const sharpFn = vi.fn(() => mockSharpInstance);
  return {
    default: sharpFn,
  };
});

describe("CaptureService", () => {
  let captureService: CaptureService;

  beforeEach(() => {
    vi.clearAllMocks();
    captureService = new CaptureService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getMonitorLayout", () => {
    it("should return monitor layout information", () => {
      const layout = captureService.getMonitorLayout();

      expect(layout).toHaveLength(2);
      expect(layout[0]).toEqual({
        id: "1",
        name: "Display 1",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        isPrimary: true,
      });
      expect(layout[1]).toEqual({
        id: "2",
        name: "Display 2",
        bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
        isPrimary: false,
      });
    });

    it("should identify primary display correctly", () => {
      const layout = captureService.getMonitorLayout();

      const primaryDisplays = layout.filter((m) => m.isPrimary);
      expect(primaryDisplays).toHaveLength(1);
      expect(primaryDisplays[0].id).toBe("1");
    });
  });

  describe("captureScreens", () => {
    it("should capture all screens", async () => {
      const result = await captureService.captureScreens();

      expect(result).toBeDefined();
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it("should handle single monitor without stitching", async () => {
      const result = await captureService.captureScreens();

      // With mocked single monitor, isComposite should be false
      expect(result.isComposite).toBe(false);
    });

    it("should respect stitchMultiMonitor option", async () => {
      const result = await captureService.captureScreens({
        stitchMultiMonitor: false,
      });

      expect(result.isComposite).toBe(false);
    });
  });

  describe("calculateBoundingBox", () => {
    it("should calculate correct bounding box for single monitor", () => {
      const monitors = [{ x: 0, y: 0, width: 1920, height: 1080 }];

      const result = captureService.calculateBoundingBox(monitors as never);

      expect(result).toEqual({
        minX: 0,
        minY: 0,
        width: 1920,
        height: 1080,
      });
    });

    it("should calculate correct bounding box for side-by-side monitors", () => {
      const monitors = [
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 1920, y: 0, width: 1920, height: 1080 },
      ];

      const result = captureService.calculateBoundingBox(monitors as never);

      expect(result).toEqual({
        minX: 0,
        minY: 0,
        width: 3840,
        height: 1080,
      });
    });

    it("should calculate correct bounding box for stacked monitors", () => {
      const monitors = [
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 1080, width: 1920, height: 1080 },
      ];

      const result = captureService.calculateBoundingBox(monitors as never);

      expect(result).toEqual({
        minX: 0,
        minY: 0,
        width: 1920,
        height: 2160,
      });
    });

    it("should handle monitors with negative coordinates", () => {
      const monitors = [
        { x: -1920, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 1080 },
      ];

      const result = captureService.calculateBoundingBox(monitors as never);

      expect(result).toEqual({
        minX: -1920,
        minY: 0,
        width: 3840,
        height: 1080,
      });
    });

    it("should return zero dimensions for empty monitor list", () => {
      const result = captureService.calculateBoundingBox([]);

      expect(result).toEqual({
        minX: 0,
        minY: 0,
        width: 0,
        height: 0,
      });
    });
  });

  describe("error handling", () => {
    it("should throw CaptureError when no monitors available", async () => {
      // Override the mock to return empty array
      const nodeScreenshots = await import("node-screenshots");
      vi.mocked(nodeScreenshots.Monitor.all).mockReturnValue([]);

      // Create a new instance to use the updated mock
      const service = new CaptureService();

      await expect(service.captureScreens()).rejects.toThrow(CaptureError);
    });
  });
});
