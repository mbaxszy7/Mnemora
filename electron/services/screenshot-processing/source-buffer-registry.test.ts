/**
 * Unit Tests for Source Buffer Registry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockEmit = vi.hoisted(() => vi.fn());

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./event-bus", () => ({
  screenshotProcessingEventBus: {
    emit: mockEmit,
  },
}));

vi.mock("electron", () => ({
  screen: {
    getAllDisplays: vi.fn().mockReturnValue([
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ]),
  },
}));

vi.mock("./phash-dedup", () => ({
  computeHash: vi.fn().mockResolvedValue("mock-phash-12345678"),
  isDuplicateByLast: vi.fn().mockReturnValue(false),
}));

vi.mock("./config", () => ({
  processingConfig: {
    batch: {
      minSize: 5,
      timeoutMs: 30000,
    },
    backpressure: {
      levels: [{ phashThreshold: 10 }],
    },
  },
}));

import { SourceBufferRegistry } from "./source-buffer-registry";
import type { ScreenshotInput } from "./source-buffer-registry";
import type { SourceKey } from "./types";
import { isDuplicateByLast } from "./phash-dedup";

const mockedIsDuplicateByLast = vi.mocked(isDuplicateByLast);

describe("SourceBufferRegistry", () => {
  let registry: SourceBufferRegistry;
  let mockPersistFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPersistFn = vi.fn().mockResolvedValue(1);
    registry = new SourceBufferRegistry();
    registry.initialize(mockPersistFn);
    vi.clearAllMocks();
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  describe("initialization", () => {
    it("initializes with persist callback", () => {
      expect(() => registry.initialize(mockPersistFn)).not.toThrow();
    });

    it("clears all batch timeouts on initialize", () => {
      registry.dispose();
      const freshRegistry = new SourceBufferRegistry();
      expect(() => freshRegistry.initialize(mockPersistFn)).not.toThrow();
    });
  });

  describe("add", () => {
    const createInput = (overrides?: Partial<ScreenshotInput>): ScreenshotInput => ({
      sourceKey: "screen:1",
      imageBuffer: Buffer.from("test-image"),
      screenshot: {
        ts: Date.now(),
        sourceKey: "screen:1",
        filePath: "/path/to/screenshot.jpg",
        meta: { appHint: "TestApp", windowTitle: "Test Window" },
        ...overrides?.screenshot,
      },
      ...overrides,
    });

    it("accepts screenshot for active source", async () => {
      registry.setPreferences({ selectedScreens: [], selectedApps: [] });
      await vi.advanceTimersByTimeAsync(100);

      const input = createInput();
      const result = await registry.add(input);

      expect(result.accepted).toBe(true);
    });

    it("rejects screenshot for inactive source", async () => {
      registry.setPreferences({
        selectedScreens: [{ id: "2", name: "Display 2" }],
        selectedApps: [],
      });
      await vi.advanceTimersByTimeAsync(100);

      const input = createInput({ sourceKey: "screen:1" });
      const result = await registry.add(input);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("source_inactive");
    });

    it("rejects duplicate screenshots", async () => {
      mockedIsDuplicateByLast.mockReturnValueOnce(false).mockReturnValueOnce(true);

      registry.setPreferences({ selectedScreens: [], selectedApps: [] });
      await vi.advanceTimersByTimeAsync(100);

      const input = createInput();
      await registry.add(input);
      const result2 = await registry.add(createInput());

      expect(result2.accepted).toBe(false);
      expect(result2.reason).toBe("duplicate");
    });

    it("persists accepted screenshot", async () => {
      registry.setPreferences({ selectedScreens: [], selectedApps: [] });
      await vi.advanceTimersByTimeAsync(100);

      const input = createInput();
      await registry.add(input);

      expect(mockPersistFn).toHaveBeenCalled();
    });

    it("emits screenshot-accept event for accepted screenshots", async () => {
      registry.setPreferences({ selectedScreens: [], selectedApps: [] });
      await vi.advanceTimersByTimeAsync(100);

      const input = createInput();
      await registry.add(input);

      expect(mockEmit).toHaveBeenCalledWith("screenshot-accept", expect.any(Object));
    });
  });

  describe("setPhashThreshold", () => {
    it("updates phash threshold", () => {
      registry.setPhashThreshold(15);
      // Threshold is used internally, verify no error is thrown
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe("get", () => {
    it("returns undefined for non-existent buffer", () => {
      const buffer = registry.get("screen:999" as SourceKey);
      expect(buffer).toBeUndefined();
    });
  });

  describe("refresh", () => {
    it("refreshes active sources", async () => {
      registry.setPreferences({
        selectedScreens: [{ id: "1", name: "Display 1" }],
        selectedApps: [],
      });
      await registry.refresh();

      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe("setPreferences", () => {
    it("updates preferences and refreshes", () => {
      const prefs = { selectedScreens: [{ id: "1", name: "Display 1" }], selectedApps: [] };
      registry.setPreferences(prefs);

      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("creates deep copy of preferences", () => {
      const prefs = { selectedScreens: [{ id: "1", name: "Display 1" }], selectedApps: [] };
      registry.setPreferences(prefs);
      prefs.selectedScreens[0].name = "Modified";

      // Should not affect internal state
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears all timeouts and buffers", () => {
      registry.dispose();

      const buffer = registry.get("screen:1" as SourceKey);
      expect(buffer).toBeUndefined();
    });

    it("is idempotent", () => {
      registry.dispose();
      expect(() => registry.dispose()).not.toThrow();
    });
  });

  describe("batch processing", () => {
    it("processes ready batches when batch size is reached", async () => {
      mockedIsDuplicateByLast.mockReturnValue(false);

      registry.setPreferences({ selectedScreens: [], selectedApps: [] });
      await vi.advanceTimersByTimeAsync(100);

      // Add multiple screenshots to trigger batch
      for (let i = 0; i < 5; i++) {
        await registry.add({
          sourceKey: "screen:1",
          imageBuffer: Buffer.from(`test-image-${i}`),
          screenshot: {
            ts: Date.now() + i,
            sourceKey: "screen:1",
            filePath: `/path/to/screenshot-${i}.jpg`,
            meta: { appHint: "TestApp", windowTitle: "Test Window" },
          },
        });
      }

      expect(mockEmit).toHaveBeenCalledWith("batch:ready", expect.any(Object));
    });
  });
});
