import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mocks Setup (must be before any imports)
// ============================================================================

const mockApp = {
  getName: vi.fn(() => "Mnemora"),
  quit: vi.fn(),
  setAppUserModelId: vi.fn(),
};

vi.mock("electron", () => ({
  app: mockApp,
}));

const mockSpawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock("./services/logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./env", () => ({
  APP_ROOT: "/test/app/root",
  VITE_PUBLIC: "/test/public",
}));

// ============================================================================
// Test Suite
// ============================================================================

describe("startup.ts - Initialization Module", () => {
  let originalArgv: string[];
  let originalPlatform: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    originalPlatform = process.platform;
    originalEnv = { ...process.env };

    // Reset process event listeners
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");

    // Ensure VITEST env is set
    process.env.VITEST = "true";
  });

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
    process.env = originalEnv;
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
  });

  describe("handleSquirrelEvents", () => {
    it("should handle --squirrel-install on Windows", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });
      process.argv = ["electron.exe", "--squirrel-install"];

      const { handleSquirrelEvents } = await import("./startup");
      const result = handleSquirrelEvents();

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining("Update.exe"),
        ["--createShortcut", expect.any(String)],
        { detached: true }
      );
      expect(mockApp.quit).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("should handle --squirrel-uninstall on Windows", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });
      process.argv = ["electron.exe", "--squirrel-uninstall"];

      const { handleSquirrelEvents } = await import("./startup");
      const result = handleSquirrelEvents();

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining("Update.exe"),
        ["--removeShortcut", expect.any(String)],
        { detached: true }
      );
      expect(mockApp.quit).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("should handle --squirrel-updated on Windows", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });
      process.argv = ["electron.exe", "--squirrel-updated"];

      const { handleSquirrelEvents } = await import("./startup");
      const result = handleSquirrelEvents();

      expect(mockSpawn).toHaveBeenCalled();
      expect(mockApp.quit).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("should handle --squirrel-obsolete on Windows", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });
      process.argv = ["electron.exe", "--squirrel-obsolete"];
      mockSpawn.mockClear();

      const { handleSquirrelEvents } = await import("./startup");
      const result = handleSquirrelEvents();

      // Should not spawn anything for obsolete
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockApp.quit).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("should ignore squirrel events on non-Windows platforms", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        writable: true,
        configurable: true,
      });
      process.argv = ["electron", "--squirrel-install"];
      mockSpawn.mockClear();

      const { handleSquirrelEvents } = await import("./startup");
      const result = handleSquirrelEvents();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockApp.quit).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("should return false when no squirrel command", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });
      process.argv = ["electron.exe"];

      const { handleSquirrelEvents } = await import("./startup");
      const result = handleSquirrelEvents();

      expect(mockApp.quit).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });
  });

  describe("registerGlobalErrorHandlers", () => {
    it("should register uncaughtException handler", async () => {
      const { registerGlobalErrorHandlers } = await import("./startup");
      registerGlobalErrorHandlers();

      const listeners = process.listeners("uncaughtException");
      expect(listeners.length).toBeGreaterThan(0);
    });

    it("should register unhandledRejection handler", async () => {
      const { registerGlobalErrorHandlers } = await import("./startup");
      registerGlobalErrorHandlers();

      const listeners = process.listeners("unhandledRejection");
      expect(listeners.length).toBeGreaterThan(0);
    });

    it("uncaughtException handler should log errors", async () => {
      const { registerGlobalErrorHandlers } = await import("./startup");
      registerGlobalErrorHandlers();

      const listeners = process.listeners("uncaughtException");
      const handler = listeners[0] as (error: Error) => void;
      const testError = new Error("Test error");

      // Should not throw when handling error
      expect(() => handler(testError)).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should fall back to console when logger fails", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { getLogger } = await import("./services/logger");
      vi.mocked(getLogger).mockImplementationOnce(() => {
        throw new Error("Logger not initialized");
      });

      const { registerGlobalErrorHandlers } = await import("./startup");
      registerGlobalErrorHandlers();

      const listeners = process.listeners("uncaughtException");
      const handler = listeners[0] as (error: Error) => void;
      const testError = new Error("Test error");

      handler(testError);

      expect(consoleSpy).toHaveBeenCalledWith("[uncaughtException]", testError);
      consoleSpy.mockRestore();
    });
  });

  describe("setupEnvironment", () => {
    it("should set APP_ROOT environment variable", async () => {
      delete process.env.APP_ROOT;

      const { setupEnvironment } = await import("./startup");
      setupEnvironment();

      expect(process.env.APP_ROOT).toBe("/test/app/root");
    });

    it("should preserve existing APP_ROOT if set", async () => {
      process.env.APP_ROOT = "/existing/path";

      const { setupEnvironment } = await import("./startup");
      setupEnvironment();

      expect(process.env.APP_ROOT).toBe("/existing/path");
    });

    it("should set VITE_PUBLIC environment variable", async () => {
      delete process.env.VITE_PUBLIC;

      const { setupEnvironment } = await import("./startup");
      setupEnvironment();

      expect(process.env.VITE_PUBLIC).toBe("/test/public");
    });

    it("should preserve existing VITE_PUBLIC if set", async () => {
      process.env.VITE_PUBLIC = "/existing/public";

      const { setupEnvironment } = await import("./startup");
      setupEnvironment();

      expect(process.env.VITE_PUBLIC).toBe("/existing/public");
    });

    it("should set app user model id on Windows", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });

      const { setupEnvironment } = await import("./startup");
      setupEnvironment();

      expect(mockApp.setAppUserModelId).toHaveBeenCalledWith(mockApp.getName());
    });

    it("should not set app user model id on non-Windows", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        writable: true,
        configurable: true,
      });

      const { setupEnvironment } = await import("./startup");
      setupEnvironment();

      expect(mockApp.setAppUserModelId).not.toHaveBeenCalled();
    });
  });
});
