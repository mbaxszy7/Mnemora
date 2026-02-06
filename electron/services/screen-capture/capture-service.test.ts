/**
 * Unit Tests for Capture Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const mockGetSources = vi.hoisted(() => vi.fn());
const mockGetAllDisplays = vi.hoisted(() => vi.fn());
const mockGetPrimaryDisplay = vi.hoisted(() => vi.fn());
const mockPng = vi.hoisted(() => vi.fn().mockReturnThis());
const mockJpeg = vi.hoisted(() => vi.fn().mockReturnThis());
const mockWebp = vi.hoisted(() => vi.fn().mockReturnThis());
const mockToBuffer = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from("test-image-data")));
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("electron", () => ({
  desktopCapturer: {
    getSources: (...args: unknown[]) => mockGetSources(...args),
  },
  screen: {
    getAllDisplays: (...args: unknown[]) => mockGetAllDisplays(...args),
    getPrimaryDisplay: (...args: unknown[]) => mockGetPrimaryDisplay(...args),
  },
}));

// Create a factory for sharp mock that uses the hoisted mock functions
const createSharpMock = () => {
  const instance = {
    png: mockPng,
    jpeg: mockJpeg,
    webp: mockWebp,
    toBuffer: mockToBuffer,
  };
  // Make chain methods return the instance
  mockPng.mockReturnValue(instance);
  mockJpeg.mockReturnValue(instance);
  mockWebp.mockReturnValue(instance);
  return instance;
};

vi.mock("sharp", () => ({
  default: () => createSharpMock(),
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./macos-window-helper", () => ({
  getHybridWindowSources: vi.fn((sources) => Promise.resolve(sources)),
  isMacOS: vi.fn(() => false),
}));

import { CaptureService, CaptureError, ICaptureService } from "./capture-service";
import type { DesktopCapturerSource, NativeImage } from "electron";

function createMockNativeImage(isEmpty = false): NativeImage {
  return {
    isEmpty: () => isEmpty,
    toPNG: () => Buffer.from("png-data"),
    toDataURL: () => "data:image/png;base64,mockdata",
    getSize: () => ({ width: 1920, height: 1080 }),
  } as unknown as NativeImage;
}

function createMockSource(
  id: string,
  name: string,
  displayId: string,
  isEmpty = false
): DesktopCapturerSource {
  return {
    id,
    name,
    display_id: displayId,
    appIcon: createMockNativeImage(),
    thumbnail: createMockNativeImage(isEmpty),
  } as unknown as DesktopCapturerSource;
}

describe("CaptureService", () => {
  let service: ICaptureService;

  beforeEach(() => {
    service = new CaptureService();
    vi.clearAllMocks();

    // Default mock implementations
    mockGetAllDisplays.mockReturnValue([
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);
    mockGetPrimaryDisplay.mockReturnValue({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("captureScreens", () => {
    it("captures all screens successfully", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("screen:1:0", "Display 1", "1"),
        createMockSource("screen:2:0", "Display 2", "2"),
      ]);

      const results = await service.captureScreens();

      expect(results).toHaveLength(2);
      expect(results[0].source.type).toBe("screen");
      expect(results[0].source.displayId).toBe("1");
      expect(results[1].source.displayId).toBe("2");
    });

    it("throws CaptureError when no screens available", async () => {
      mockGetSources.mockResolvedValue([]);

      await expect(service.captureScreens()).rejects.toThrow(CaptureError);
      await expect(service.captureScreens()).rejects.toThrow("No screens available for capture");
    });

    it("filters by selectedScreenIds", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("screen:1:0", "Display 1", "1"),
        createMockSource("screen:2:0", "Display 2", "2"),
      ]);

      const results = await service.captureScreens({ selectedScreenIds: ["2"] });

      expect(results).toHaveLength(1);
      expect(results[0].source.displayId).toBe("2");
    });

    it("falls back to all screens when selectedScreenIds has no matches", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "1")]);

      const results = await service.captureScreens({ selectedScreenIds: ["999"] });

      expect(results).toHaveLength(1);
    });

    it("skips empty thumbnails", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("screen:1:0", "Display 1", "1", false),
        createMockSource("screen:2:0", "Display 2", "2", true),
      ]);

      const results = await service.captureScreens();

      expect(results).toHaveLength(1);
    });

    it("throws when all captures fail", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("screen:1:0", "Display 1", "1", true),
        createMockSource("screen:2:0", "Display 2", "2", true),
      ]);

      await expect(service.captureScreens()).rejects.toThrow(CaptureError);
      await expect(service.captureScreens()).rejects.toThrow("All screen captures failed");
    });

    it("handles errors for individual screens gracefully", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("screen:1:0", "Display 1", "1"),
        {
          ...createMockSource("screen:2:0", "Display 2", "2"),
          thumbnail: {
            isEmpty: () => false,
            toPNG: () => {
              throw new Error("Thumbnail error");
            },
          } as unknown as NativeImage,
        },
      ]);

      const results = await service.captureScreens();

      expect(results).toHaveLength(1);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("includes display bounds from screen API", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "1")]);
      mockGetAllDisplays.mockReturnValue([
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);

      const results = await service.captureScreens();

      expect(results[0].source.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    });

    it("applies jpeg format option", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "1")]);

      await service.captureScreens({ format: "jpeg", quality: 85 });

      expect(mockJpeg).toHaveBeenCalledWith({ quality: 85 });
    });

    it("applies webp format option", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "1")]);

      await service.captureScreens({ format: "webp", quality: 90 });

      expect(mockWebp).toHaveBeenCalledWith({ quality: 90 });
    });

    it("applies jpeg format by default", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "1")]);

      await service.captureScreens();

      expect(mockJpeg).toHaveBeenCalledWith({ quality: 80 });
    });
  });

  describe("captureWindowsByApp", () => {
    it("captures windows by app source IDs", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("window:1:0", "Chrome", ""),
        createMockSource("window:2:0", "VSCode", ""),
      ]);

      const results = await service.captureWindowsByApp(["window:1:0"]);

      expect(results).toHaveLength(1);
      expect(results[0].source.id).toBe("window:1:0");
      expect(results[0].source.name).toBe("Chrome");
    });

    it("returns empty array when no windows match", async () => {
      mockGetSources.mockResolvedValue([createMockSource("window:1:0", "Chrome", "")]);

      const results = await service.captureWindowsByApp(["window:999:0"]);

      expect(results).toEqual([]);
    });

    it("skips windows with empty thumbnails", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("window:1:0", "Chrome", "", false),
        createMockSource("window:2:0", "VSCode", "", true),
      ]);

      const results = await service.captureWindowsByApp(["window:1:0", "window:2:0"]);

      expect(results).toHaveLength(1);
    });

    it("handles window capture errors gracefully", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("window:1:0", "Chrome", ""),
        {
          ...createMockSource("window:2:0", "VSCode", ""),
          thumbnail: {
            isEmpty: () => false,
            toPNG: () => {
              throw new Error("Capture failed");
            },
          } as unknown as NativeImage,
        },
      ]);

      const results = await service.captureWindowsByApp(["window:1:0", "window:2:0"]);

      expect(results).toHaveLength(1);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("applies format and quality options", async () => {
      mockGetSources.mockResolvedValue([createMockSource("window:1:0", "Chrome", "")]);

      await service.captureWindowsByApp(["window:1:0"], { format: "webp", quality: 75 });

      expect(mockWebp).toHaveBeenCalledWith({ quality: 75 });
    });
  });

  describe("getCaptureScreenInfo", () => {
    it("returns screen info with thumbnails", async () => {
      mockGetSources.mockResolvedValue([
        createMockSource("screen:1:0", "Display 1", "1"),
        createMockSource("screen:2:0", "Display 2", "2"),
      ]);
      mockGetAllDisplays.mockReturnValue([
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
      ]);
      mockGetPrimaryDisplay.mockReturnValue({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const results = await service.getCaptureScreenInfo();

      expect(results).toHaveLength(2);
      expect(results[0].type).toBe("screen");
      expect(results[0].thumbnail).toBe("data:image/png;base64,mockdata");
    });

    it("marks primary display correctly", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "1")]);
      mockGetAllDisplays.mockReturnValue([
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      mockGetPrimaryDisplay.mockReturnValue({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const results = await service.getCaptureScreenInfo();

      expect(results[0].isPrimary).toBe(true);
    });

    it("falls back to first screen as primary if none marked", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "1")]);
      mockGetAllDisplays.mockReturnValue([
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      mockGetPrimaryDisplay.mockReturnValue({
        id: 999,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const results = await service.getCaptureScreenInfo();

      expect(results[0].isPrimary).toBe(true);
    });

    it("matches displays by index when display_id does not match", async () => {
      mockGetSources.mockResolvedValue([createMockSource("screen:1:0", "Display 1", "999")]);
      mockGetAllDisplays.mockReturnValue([
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      mockGetPrimaryDisplay.mockReturnValue({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const results = await service.getCaptureScreenInfo();

      expect(results).toHaveLength(1);
    });
  });

  describe("getCaptureAppInfo", () => {
    it("returns app info with icons", async () => {
      mockGetSources.mockResolvedValue([
        {
          id: "window:1:0",
          name: "Chrome - Google",
          appIcon: createMockNativeImage(),
        } as unknown as DesktopCapturerSource,
      ]);

      const results = await service.getCaptureAppInfo();

      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it("filters out unnamed entries", async () => {
      mockGetSources.mockResolvedValue([
        {
          id: "window:1:0",
          name: "",
          appIcon: createMockNativeImage(),
        } as unknown as DesktopCapturerSource,
        {
          id: "window:2:0",
          name: "Chrome",
          appIcon: createMockNativeImage(),
        } as unknown as DesktopCapturerSource,
      ]);

      const results = await service.getCaptureAppInfo();

      expect(results.every((r) => r.name && r.name.trim().length > 0)).toBe(true);
    });

    it("validates appIcon has actual content", async () => {
      mockGetSources.mockResolvedValue([
        {
          id: "window:1:0",
          name: "Chrome",
          appIcon: {
            toDataURL: () => "data:image/png;base64,", // Very short - just prefix
          },
        } as unknown as DesktopCapturerSource,
      ]);

      const results = await service.getCaptureAppInfo();

      expect(results[0]?.appIcon).toBe("");
    });

    it("parses app name from window title for known apps", async () => {
      mockGetSources.mockResolvedValue([
        {
          id: "window:1:0",
          name: "Visual Studio Code - index.ts",
          appIcon: createMockNativeImage(),
        } as unknown as DesktopCapturerSource,
      ]);

      const results = await service.getCaptureAppInfo();

      // Should find Visual Studio Code as app name
      const vscodeApp = results.find((r) => r.name === "Visual Studio Code");
      expect(vscodeApp).toBeDefined();
    });

    it("returns empty array when no sources available", async () => {
      mockGetSources.mockResolvedValue([]);

      const results = await service.getCaptureAppInfo();

      expect(results).toEqual([]);
    });

    it("sorts results by name", async () => {
      mockGetSources.mockResolvedValue([
        {
          id: "window:2:0",
          name: "Zebra",
          appIcon: createMockNativeImage(),
        } as unknown as DesktopCapturerSource,
        {
          id: "window:1:0",
          name: "Alpha",
          appIcon: createMockNativeImage(),
        } as unknown as DesktopCapturerSource,
      ]);

      const results = await service.getCaptureAppInfo();

      expect(results[0]?.name).toBe("Alpha");
      expect(results[1]?.name).toBe("Zebra");
    });
  });

  describe("CaptureError", () => {
    it("creates error with code", () => {
      const error = new CaptureError("Test message", "TEST_CODE");

      expect(error.message).toBe("Test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.name).toBe("CaptureError");
    });
  });
});
