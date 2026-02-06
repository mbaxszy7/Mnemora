import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  desktopCapturer: {
    getSources: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { CaptureSourceProvider } from "./capture-source-provider";
import { desktopCapturer } from "electron";

describe("CaptureSourceProvider", () => {
  let provider: CaptureSourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CaptureSourceProvider(100); // short cache interval for testing
  });

  describe("getScreensSources", () => {
    it("fetches screen sources from desktopCapturer", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "screen:0", name: "Screen 1", display_id: "1" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      const result = await provider.getScreensSources();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("screen:0");
      expect(result[0].type).toBe("screen");
      expect(result[0].displayId).toBe("1");
    });

    it("returns cached screens within cache interval", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "screen:0", name: "Screen 1", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await provider.getScreensSources();
      await provider.getScreensSources();

      expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1);
    });

    it("handles empty display_id", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "screen:0", name: "Screen 1", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      const result = await provider.getScreensSources();
      expect(result[0].displayId).toBeUndefined();
    });
  });

  describe("getWindowsSources", () => {
    it("fetches all windows when no appSourceIds provided", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "window:1", name: "VS Code", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      const result = await provider.getWindowsSources();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("window");
      expect(result[0].isVisible).toBe(true);
    });

    it("fetches windows with appSourceIds filter", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "window:1", name: "VS Code", display_id: "" },
        { id: "window:2", name: "Chrome", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      const result = await provider.getWindowsSources(["window:1", "window:3"]);

      expect(result).toHaveLength(2);
      // window:1 is visible (found in sources)
      expect(result[0].isVisible).toBe(true);
      expect(result[0].name).toBe("VS Code");
      // window:3 is not visible (not found)
      expect(result[1].isVisible).toBe(false);
      expect(result[1].name).toBe("Unknown");
    });

    it("returns cached windows within cache interval", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "window:1", name: "VS Code", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await provider.getWindowsSources();
      await provider.getWindowsSources();

      expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1);
    });

    it("uses different cache keys for different appSourceIds", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "window:1", name: "VS Code", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await provider.getWindowsSources(["window:1"]);
      await provider.getWindowsSources(["window:2"]);

      expect(desktopCapturer.getSources).toHaveBeenCalledTimes(2);
    });

    it("handles desktopCapturer error gracefully", async () => {
      vi.mocked(desktopCapturer.getSources).mockRejectedValue(new Error("access denied"));

      const result = await provider.getWindowsSources();

      expect(result).toEqual([]);
    });

    it("returns empty cache key for empty appSourceIds array", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "window:1", name: "VS Code", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await provider.getWindowsSources([]);
      await provider.getWindowsSources();

      // Both should use same cache key (empty)
      expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearCache", () => {
    it("clears all caches", async () => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        { id: "screen:0", name: "Screen 1", display_id: "" },
      ] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await provider.getScreensSources();
      provider.clearCache();
      await provider.getScreensSources();

      expect(desktopCapturer.getSources).toHaveBeenCalledTimes(2);
    });
  });
});
