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

  describe("captureScreens", () => {
    it("should capture all screens and return array", async () => {
      const results = await captureService.captureScreens();

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].buffer).toBeInstanceOf(Buffer);
      expect(results[0].timestamp).toBeLessThanOrEqual(Date.now());
    });

    it("should return one result per monitor", async () => {
      const results = await captureService.captureScreens();

      // With mocked single monitor, should return one result
      expect(results.length).toBe(1);
      expect(results[0].screenId).toBeDefined();
      expect(results[0].source).toBeDefined();
      expect(results[0].source.type).toBe("screen");
    });
  });

  describe("mapScreenIdsToDisplayIds", () => {
    it("should map screen IDs to display IDs correctly", () => {
      const screenInfos = [
        {
          id: "screen:0:0",
          displayId: "1",
          name: "Display 1",
          thumbnail: "",
          width: 1920,
          height: 1080,
          isPrimary: true,
        },
        {
          id: "screen:1:0",
          displayId: "2",
          name: "Display 2",
          thumbnail: "",
          width: 1920,
          height: 1080,
          isPrimary: false,
        },
      ];

      const result = captureService.mapScreenIdsToDisplayIds(
        ["screen:0:0", "screen:1:0"],
        screenInfos
      );

      expect(result).toEqual(["1", "2"]);
    });

    it("should handle missing screen IDs gracefully", () => {
      const screenInfos = [
        {
          id: "screen:0:0",
          displayId: "1",
          name: "Display 1",
          thumbnail: "",
          width: 1920,
          height: 1080,
          isPrimary: true,
        },
      ];

      const result = captureService.mapScreenIdsToDisplayIds(
        ["screen:0:0", "screen:99:0"],
        screenInfos
      );

      expect(result).toEqual(["1"]);
    });

    it("should return empty array when no matches", () => {
      const result = captureService.mapScreenIdsToDisplayIds(["nonexistent"], []);

      expect(result).toEqual([]);
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
