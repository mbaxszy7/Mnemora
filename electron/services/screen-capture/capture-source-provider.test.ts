/**
 * Unit Tests for CaptureSourceProvider
 *
 * Tests for stale reference handling and cache integration
 * Requirements: 4.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CaptureSourceProvider } from "./capture-source-provider";

// Mock Electron's desktopCapturer
vi.mock("electron", () => ({
  desktopCapturer: {
    getSources: vi.fn(),
  },
}));

// Mock macos-window-helper to avoid AppleScript execution in tests
vi.mock("./macos-window-helper", () => ({
  isMacOS: vi.fn(() => false), // Default to non-macOS for most tests
  getHybridWindowSources: vi.fn((sources) => Promise.resolve(sources)),
}));

import { desktopCapturer } from "electron";
// import { isMacOS, getHybridWindowSources } from "./macos-window-helper";

const mockGetSources = vi.mocked(desktopCapturer.getSources);
// const mockIsMacOS = vi.mocked(isMacOS);
// const mockGetHybridWindowSources = vi.mocked(getHybridWindowSources);

describe("CaptureSourceProvider Unit Tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Cache integration", () => {
    it("should use AutoRefreshCache for source caching", async () => {
      const mockSources = [
        { id: "screen:0:0", name: "Screen 1", display_id: "0", appIcon: null },
        { id: "window:1:0", name: "App Window", display_id: "", appIcon: null },
      ];
      mockGetSources.mockResolvedValue(mockSources as never);

      const provider = new CaptureSourceProvider({
        cacheInterval: 3000,
        immediate: true,
      });

      // Let the immediate fetch complete
      await vi.advanceTimersByTimeAsync(0);

      // Should have fetched sources
      expect(mockGetSources).toHaveBeenCalledTimes(1);

      // Should return cached data
      const sources = provider.getSources();
      expect(sources).toHaveLength(2);
      expect(sources[0].type).toBe("screen");
      expect(sources[1].type).toBe("window");

      provider.dispose();
    });

    it("should refresh cache at configured interval", async () => {
      mockGetSources.mockResolvedValue([]);

      const provider = new CaptureSourceProvider({
        cacheInterval: 1000,
        immediate: true,
      });

      // Initial fetch
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGetSources).toHaveBeenCalledTimes(1);

      // Advance to trigger refresh
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockGetSources).toHaveBeenCalledTimes(2);

      // Another refresh
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockGetSources).toHaveBeenCalledTimes(3);

      provider.dispose();
    });

    it("should stop cache refresh on dispose", async () => {
      mockGetSources.mockResolvedValue([]);

      const provider = new CaptureSourceProvider({
        cacheInterval: 1000,
        immediate: true,
      });

      // Initial fetch
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGetSources).toHaveBeenCalledTimes(1);

      // Dispose
      provider.dispose();

      // Advance time - no more fetches should occur
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockGetSources).toHaveBeenCalledTimes(1);
    });
  });

  describe("Stale reference handling", () => {
    it("should return empty array when cache has no data", () => {
      mockGetSources.mockResolvedValue([]);

      const provider = new CaptureSourceProvider({
        immediate: false,
      });

      // No data fetched yet
      const sources = provider.getSources();
      expect(sources).toEqual([]);

      provider.dispose();
    });

    it("should handle fetch errors gracefully via onError callback", async () => {
      // First call succeeds to populate cache
      mockGetSources.mockResolvedValueOnce([
        { id: "screen:0:0", name: "Screen", display_id: "0", appIcon: null },
      ] as never);
      // Second call fails
      const error = new Error("Failed to get sources");
      mockGetSources.mockRejectedValueOnce(error);

      const onError = vi.fn();
      const provider = new CaptureSourceProvider({
        cacheInterval: 1000,
        immediate: true,
        onError,
      });

      // Let the initial fetch complete
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.getSources()).toHaveLength(1);

      // Advance to trigger refresh that will fail
      await vi.advanceTimersByTimeAsync(1000);

      // Error callback should have been called
      expect(onError).toHaveBeenCalledWith(error);

      // Previous data should be retained
      expect(provider.getSources()).toHaveLength(1);

      provider.dispose();
    });

    it("should retain previous data when refresh fails", async () => {
      const initialSources = [
        { id: "screen:0:0", name: "Screen 1", display_id: "0", appIcon: null },
      ];

      // First call succeeds
      mockGetSources.mockResolvedValueOnce(initialSources as never);
      // Second call fails
      mockGetSources.mockRejectedValueOnce(new Error("Network error"));

      const provider = new CaptureSourceProvider({
        cacheInterval: 1000,
        immediate: true,
      });

      // Initial fetch succeeds
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.getSources()).toHaveLength(1);

      // Refresh fails - should retain previous data
      await vi.advanceTimersByTimeAsync(1000);
      expect(provider.getSources()).toHaveLength(1);

      provider.dispose();
    });

    it("should allow manual refresh to recover from stale data", async () => {
      const oldSources = [{ id: "screen:0:0", name: "Old Screen", display_id: "0", appIcon: null }];
      const newSources = [
        { id: "screen:0:0", name: "New Screen", display_id: "0", appIcon: null },
        { id: "window:1:0", name: "New Window", display_id: "", appIcon: null },
      ];

      mockGetSources.mockResolvedValueOnce(oldSources as never);
      mockGetSources.mockResolvedValueOnce(newSources as never);

      const provider = new CaptureSourceProvider({
        cacheInterval: 10000, // Long interval
        immediate: true,
      });

      // Initial fetch
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.getSources()).toHaveLength(1);

      // Manual refresh
      await provider.refresh();
      expect(provider.getSources()).toHaveLength(2);

      provider.dispose();
    });
  });

  describe("Source filtering", () => {
    it("should correctly identify screen vs window sources by ID prefix", async () => {
      const mockSources = [
        { id: "screen:0:0", name: "Display 1", display_id: "0", appIcon: null },
        { id: "screen:1:0", name: "Display 2", display_id: "1", appIcon: null },
        { id: "window:123:0", name: "Chrome", display_id: "", appIcon: null },
        { id: "window:456:0", name: "VS Code", display_id: "", appIcon: null },
      ];
      mockGetSources.mockResolvedValue(mockSources as never);

      const provider = new CaptureSourceProvider({ immediate: true });
      await vi.advanceTimersByTimeAsync(0);

      const screens = provider.getScreens();
      const windows = provider.getWindows();

      expect(screens).toHaveLength(2);
      expect(windows).toHaveLength(2);

      screens.forEach((s) => expect(s.type).toBe("screen"));
      windows.forEach((w) => expect(w.type).toBe("window"));

      provider.dispose();
    });

    it("should use minimal thumbnail size for performance", async () => {
      mockGetSources.mockResolvedValue([]);

      const provider = new CaptureSourceProvider({ immediate: true });
      await vi.advanceTimersByTimeAsync(0);

      // Verify getSources was called with minimal thumbnail size
      expect(mockGetSources).toHaveBeenCalledWith({
        types: ["screen", "window"],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });

      provider.dispose();
    });
  });

  describe("Convenience methods", () => {
    it("getScreens should return only screen sources", async () => {
      const mockSources = [
        { id: "screen:0:0", name: "Screen", display_id: "0", appIcon: null },
        { id: "window:1:0", name: "Window", display_id: "", appIcon: null },
      ];
      mockGetSources.mockResolvedValue(mockSources as never);

      const provider = new CaptureSourceProvider({ immediate: true });
      await vi.advanceTimersByTimeAsync(0);

      const screens = provider.getScreens();
      expect(screens).toHaveLength(1);
      expect(screens[0].name).toBe("Screen");

      provider.dispose();
    });

    it("getWindows should return only window sources", async () => {
      const mockSources = [
        { id: "screen:0:0", name: "Screen", display_id: "0", appIcon: null },
        { id: "window:1:0", name: "Window", display_id: "", appIcon: null },
      ];
      mockGetSources.mockResolvedValue(mockSources as never);

      const provider = new CaptureSourceProvider({ immediate: true });
      await vi.advanceTimersByTimeAsync(0);

      const windows = provider.getWindows();
      expect(windows).toHaveLength(1);
      expect(windows[0].name).toBe("Window");

      provider.dispose();
    });
  });
});
