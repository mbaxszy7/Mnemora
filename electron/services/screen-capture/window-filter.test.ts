/**
 * Unit Tests for WindowFilter
 *
 * Tests for minimized window exclusion and filter configuration parsing
 * Requirements: 7.4
 */

import { describe, it, expect } from "vitest";
import { windowFilter } from "./window-filter";
import type { CaptureSource } from "./types";

describe("WindowFilter Unit Tests", () => {
  describe("Minimized window exclusion", () => {
    /**
     * Requirement 7.4: When a window is minimized or hidden, exclude from active capture list
     */
    it("should exclude windows with zero width", () => {
      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: 0, height: 600 },
      };

      expect(windowFilter.shouldExclude(source)).toBe(true);
    });

    it("should exclude windows with zero height", () => {
      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: 800, height: 0 },
      };

      expect(windowFilter.shouldExclude(source)).toBe(true);
    });

    it("should exclude windows with negative dimensions", () => {
      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: -100, height: 600 },
      };

      expect(windowFilter.shouldExclude(source)).toBe(true);
    });

    it("should not exclude windows with valid dimensions", () => {
      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };

      expect(windowFilter.shouldExclude(source)).toBe(false);
    });

    it("should not exclude windows without bounds (unknown state)", () => {
      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
      };

      expect(windowFilter.shouldExclude(source)).toBe(false);
    });

    it("should never exclude screens regardless of bounds", () => {
      const source: CaptureSource = {
        id: "screen-1",
        name: "Screen 1",
        type: "screen",
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      };

      expect(windowFilter.shouldExclude(source)).toBe(false);
    });
  });

  describe("Default filter configuration", () => {
    it("should filter default system windows like Dock", () => {
      const sources: CaptureSource[] = [
        { id: "1", name: "Dock", type: "window" },
        { id: "2", name: "RegularApp", type: "window" },
      ];

      const filtered = windowFilter.filterSystemWindows(sources);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("RegularApp");
    });

    it("should normalize using default aliases", () => {
      expect(windowFilter.normalizeAppName("chrome")).toBe("Google Chrome");
      expect(windowFilter.normalizeAppName("unknown")).toBe("unknown");
    });
  });

  describe("Case insensitivity", () => {
    it("should match system windows case-insensitively", () => {
      const sources: CaptureSource[] = [
        { id: "1", name: "DOCK", type: "window" },
        { id: "2", name: "dock", type: "window" },
        { id: "3", name: "Dock", type: "window" },
        { id: "4", name: "RegularApp", type: "window" },
      ];

      const filtered = windowFilter.filterSystemWindows(sources);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("RegularApp");
    });

    it("should normalize aliases case-insensitively", () => {
      expect(windowFilter.normalizeAppName("CHROME")).toBe("Google Chrome");
      expect(windowFilter.normalizeAppName("Chrome")).toBe("Google Chrome");
      expect(windowFilter.normalizeAppName("chrome")).toBe("Google Chrome");
    });
  });

  describe("Combined filtering with shouldExclude", () => {
    it("should exclude both system windows and minimized windows", () => {
      const systemWindow: CaptureSource = {
        id: "1",
        name: "Dock",
        type: "window",
      };

      const minimizedWindow: CaptureSource = {
        id: "2",
        name: "RegularApp",
        type: "window",
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      };

      const normalWindow: CaptureSource = {
        id: "3",
        name: "NormalApp",
        type: "window",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };

      expect(windowFilter.shouldExclude(systemWindow)).toBe(true);
      expect(windowFilter.shouldExclude(minimizedWindow)).toBe(true);
      expect(windowFilter.shouldExclude(normalWindow)).toBe(false);
    });
  });
});
