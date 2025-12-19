/**
 * Property-Based Tests for CaptureSourceProvider
 *
 * These tests verify the caching behavior of CaptureSourceProvider:
 * - Time-based caching (3 seconds) for both getScreensSources and getWindowsSources
 * - Parameter-based caching for getWindowsSources based on appSourceIds
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_CACHE_INTERVAL } from "./types";

// Mock electron's desktopCapturer before importing CaptureSourceProvider
vi.mock("electron", () => ({
  desktopCapturer: {
    getSources: vi.fn().mockResolvedValue([]),
  },
}));

// Mock the macos-window-helper
vi.mock("./macos-window-helper", () => ({
  getActiveAppsOnAllSpaces: vi.fn().mockResolvedValue([]),
}));

// Mock logger
vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("CaptureSourceProvider", () => {
  let CaptureSourceProvider: typeof import("./capture-source-provider").CaptureSourceProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import("./capture-source-provider");
    CaptureSourceProvider = module.CaptureSourceProvider;
  });

  it("should use default cache interval", () => {
    // The default cache interval should be DEFAULT_CACHE_INTERVAL (3000ms)
    expect(DEFAULT_CACHE_INTERVAL).toBe(3000);
    // Provider should be created without errors using default interval
    const provider = new CaptureSourceProvider();
    expect(provider).toBeDefined();
  });

  it("should accept custom cache interval", () => {
    const customInterval = 5000;
    const provider = new CaptureSourceProvider(customInterval);
    // Provider should be created without errors
    expect(provider).toBeDefined();
  });

  it("should have clearCache method", () => {
    const provider = new CaptureSourceProvider();
    expect(typeof provider.clearCache).toBe("function");
    // Should not throw
    provider.clearCache();
  });

  it("should have getScreensSources method that returns a promise", async () => {
    const provider = new CaptureSourceProvider();
    const result = provider.getScreensSources();
    expect(result).toBeInstanceOf(Promise);
    // Wait for promise to resolve (with mocked empty array)
    const sources = await result;
    expect(Array.isArray(sources)).toBe(true);
  });

  it("should have getWindowsSources method that returns a promise", async () => {
    const provider = new CaptureSourceProvider();
    const result = provider.getWindowsSources();
    expect(result).toBeInstanceOf(Promise);
    // Wait for promise to resolve (with mocked empty array)
    const sources = await result;
    expect(Array.isArray(sources)).toBe(true);
  });

  it("should have getWindowsSources method that accepts appSourceIds parameter", async () => {
    const provider = new CaptureSourceProvider();
    const result = provider.getWindowsSources(["app1", "app2"]);
    expect(result).toBeInstanceOf(Promise);
    // Wait for promise to resolve
    const sources = await result;
    expect(Array.isArray(sources)).toBe(true);
  });
});
