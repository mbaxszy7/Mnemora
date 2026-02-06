/**
 * Unit Tests for macOS Window Helper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const mockExec = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockGetAppPath = vi.hoisted(() => vi.fn().mockReturnValue("/project/root"));

vi.mock("child_process", () => ({
  exec: vi.fn((...args: unknown[]) => {
    // Handle both (command, callback) and (command, options, callback) signatures
    const callback = args[args.length - 1] as (
      error: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    return mockExec().then(
      (result: { stdout: string; stderr: string }) => callback(null, result),
      (error: Error) => callback(error)
    );
  }),
}));

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: mockGetAppPath,
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

vi.mock("./window-filter", () => ({
  windowFilter: {
    isSystemApp: (name: string) => name.toLowerCase() === "dock" || name.toLowerCase() === "system",
    isMnemoraDevInstance: (name: string, title: string) =>
      name.toLowerCase() === "mnemora" || title.toLowerCase().includes("mnemora"),
    normalize: (str: string) => str.toLowerCase().trim(),
  },
}));

import { isMacOS, getHybridWindowSources, getActiveAppsOnAllSpaces } from "./macos-window-helper";
import type { CaptureSource } from "./types";

describe("macOS Window Helper", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  describe("isMacOS", () => {
    it("returns true on darwin platform", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      expect(isMacOS()).toBe(true);
    });

    it("returns false on win32 platform", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(isMacOS()).toBe(false);
    });

    it("returns false on linux platform", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(isMacOS()).toBe(false);
    });
  });

  describe("getHybridWindowSources", () => {
    const mockElectronSources: CaptureSource[] = [
      {
        id: "window:123:0",
        name: "Visual Studio Code - index.ts",
        type: "window",
        appIcon: "icon-data",
      },
      {
        id: "window:456:0",
        name: "Chrome - Google",
        type: "window",
        appIcon: "icon-data",
      },
      {
        id: "screen:1:0",
        name: "Display 1",
        type: "screen",
        displayId: "1",
      },
    ];

    it("returns electron sources unchanged when not on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const result = await getHybridWindowSources(mockElectronSources);

      expect(result).toEqual(mockElectronSources);
    });

    it("returns electron sources when window inspector fails", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockRejectedValue(new Error("Command failed"));

      const result = await getHybridWindowSources(mockElectronSources);

      expect(result).toEqual(mockElectronSources);
    });

    it("returns electron sources when window inspector executable not found", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExistsSync.mockReturnValue(false);

      const result = await getHybridWindowSources(mockElectronSources);

      expect(result).toEqual(mockElectronSources);
    });

    it("returns electron sources when Python inspector returns empty", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({ stdout: "", stderr: "" });

      const result = await getHybridWindowSources(mockElectronSources);

      expect(result).toEqual(mockElectronSources);
    });

    it("processes hybrid sources and filters out system apps", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: JSON.stringify([
          {
            windowId: 123,
            appName: "Code",
            windowTitle: "index.ts",
            bounds: { X: 0, Y: 0, Width: 1920, Height: 1080 },
            isOnScreen: true,
            layer: 0,
            isImportant: true,
            area: 2073600,
          },
          {
            windowId: 999,
            appName: "Dock",
            windowTitle: "",
            bounds: { X: 0, Y: 0, Width: 100, Height: 100 },
            isOnScreen: true,
            layer: 0,
            isImportant: false,
            area: 10000,
          },
        ]),
        stderr: "",
      });

      const result = await getHybridWindowSources(mockElectronSources);

      // Should filter out system app (Dock) but include Code
      const codeWindow = result.find((s) => s.id === "window:123:0");
      expect(codeWindow).toBeDefined();
      expect(codeWindow?.appName).toBe("Code");
      expect(codeWindow?.windowTitle).toBe("index.ts");
      expect(result.some((s) => s.appName === "Dock")).toBe(false);
    });

    it("filters out Mnemora dev instances", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: JSON.stringify([
          {
            windowId: 789,
            appName: "Mnemora",
            windowTitle: "Mnemora Dev",
            bounds: { X: 0, Y: 0, Width: 1920, Height: 1080 },
            isOnScreen: true,
            layer: 0,
            isImportant: true,
            area: 2073600,
          },
        ]),
        stderr: "",
      });

      const sources: CaptureSource[] = [
        {
          id: "window:789:0",
          name: "Mnemora Dev",
          type: "window",
          appIcon: "icon-data",
        },
      ];

      const result = await getHybridWindowSources(sources);

      expect(result).toHaveLength(0);
    });

    it("preserves screen sources in output", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: JSON.stringify([]),
        stderr: "",
      });

      const result = await getHybridWindowSources(mockElectronSources);

      // Screen sources should pass through
      const screenSource = result.find((s) => s.type === "screen");
      expect(screenSource).toBeDefined();
    });

    it("handles window ID parsing correctly", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: JSON.stringify([
          {
            windowId: 123,
            appName: "Code",
            windowTitle: "test.ts",
            bounds: { X: 0, Y: 0, Width: 1920, Height: 1080 },
            isOnScreen: true,
            layer: 0,
            isImportant: true,
            area: 2073600,
          },
        ]),
        stderr: "",
      });

      const sources: CaptureSource[] = [
        {
          id: "window:123:0",
          name: "Old Name",
          type: "window",
          appIcon: "icon-data",
        },
      ];

      const result = await getHybridWindowSources(sources);

      expect(result).toHaveLength(1);
      expect(result[0].appName).toBe("Code");
      expect(result[0].windowTitle).toBe("test.ts");
    });

    it("handles invalid window IDs gracefully", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: JSON.stringify([
          {
            windowId: 999,
            appName: "SomeApp",
            windowTitle: "Title",
            bounds: { X: 0, Y: 0, Width: 1920, Height: 1080 },
            isOnScreen: true,
            layer: 0,
            isImportant: true,
            area: 2073600,
          },
        ]),
        stderr: "",
      });

      const sources: CaptureSource[] = [
        {
          id: "window:123:0", // Different ID than returned by inspector
          name: "Old Name",
          type: "window",
          appIcon: "icon-data",
        },
      ];

      const result = await getHybridWindowSources(sources);

      // Should filter out unmatched windows
      expect(result).toHaveLength(0);
    });

    it("handles malformed JSON from inspector", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: "invalid json",
        stderr: "",
      });

      const result = await getHybridWindowSources(mockElectronSources);

      // Should fall back to electron sources
      expect(result).toEqual(mockElectronSources);
    });

    it("handles SIGINT gracefully", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const sigintError = new Error("Process interrupted") as Error & {
        signal: string;
        code?: number;
      };
      sigintError.signal = "SIGINT";
      sigintError.code = 130;
      mockExec.mockRejectedValue(sigintError);

      const result = await getHybridWindowSources(mockElectronSources);

      expect(result).toEqual(mockElectronSources);
    });

    it("handles SIGTERM gracefully", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const sigtermError = new Error("Process terminated") as Error & {
        signal: string;
        code?: number;
      };
      sigtermError.signal = "SIGTERM";
      sigtermError.code = 143;
      mockExec.mockRejectedValue(sigtermError);

      const result = await getHybridWindowSources(mockElectronSources);

      expect(result).toEqual(mockElectronSources);
    });

    it("handles timeout errors gracefully", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const timeoutError = new Error("Timeout") as Error & { killed: boolean; signal: string };
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";
      mockExec.mockRejectedValue(timeoutError);

      const result = await getHybridWindowSources(mockElectronSources);

      expect(result).toEqual(mockElectronSources);
    });
  });

  describe("getActiveAppsOnAllSpaces", () => {
    it("returns empty array on non-macOS platforms", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const result = await getActiveAppsOnAllSpaces();

      expect(result).toEqual([]);
    });

    it("returns list of active apps on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: "Chrome,Safari,Code|||_DELIM_|Chrome",
        stderr: "",
      });

      const result = await getActiveAppsOnAllSpaces();

      expect(result).toContain("chrome");
      expect(result).toContain("safari");
      expect(result).toContain("code");
    });

    it("returns empty array when AppleScript fails", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockRejectedValue(new Error("AppleScript failed"));

      const result = await getActiveAppsOnAllSpaces();

      expect(result).toEqual([]);
    });

    it("handles empty stdout from AppleScript", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: "",
        stderr: "",
      });

      const result = await getActiveAppsOnAllSpaces();

      expect(result).toEqual([]);
    });

    it("handles interruption signals gracefully", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const sigintError = new Error("Interrupted") as Error & { signal: string };
      sigintError.signal = "SIGINT";
      mockExec.mockRejectedValue(sigintError);

      const result = await getActiveAppsOnAllSpaces();

      expect(result).toEqual([]);
    });

    it("filters out empty app names", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: "Chrome,, ,Safari|||_DELIM_|Chrome",
        stderr: "",
      });

      const result = await getActiveAppsOnAllSpaces();

      expect(result).toContain("chrome");
      expect(result).toContain("safari");
      expect(result).not.toContain("");
      expect(result).not.toContain(" ");
    });

    it("lowercases app names", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExec.mockResolvedValue({
        stdout: "CHROME,SAFARI|||_DELIM_|Chrome",
        stderr: "",
      });

      const result = await getActiveAppsOnAllSpaces();

      expect(result).toContain("chrome");
      expect(result).toContain("safari");
      expect(result).not.toContain("CHROME");
    });
  });
});
