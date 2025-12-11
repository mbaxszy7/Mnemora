/**
 * Unit Tests for WindowFilter
 *
 * Tests for minimized window exclusion and filter configuration parsing
 * Requirements: 7.4
 */

import { describe, it, expect } from "vitest";
import { WindowFilter } from "./window-filter";
import type { CaptureSource } from "./types";

describe("WindowFilter Unit Tests", () => {
  describe("Minimized window exclusion", () => {
    /**
     * Requirement 7.4: When a window is minimized or hidden, exclude from active capture list
     */
    it("should exclude windows with zero width", () => {
      const filter = new WindowFilter();

      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: 0, height: 600 },
      };

      expect(filter.shouldExclude(source)).toBe(true);
    });

    it("should exclude windows with zero height", () => {
      const filter = new WindowFilter();

      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: 800, height: 0 },
      };

      expect(filter.shouldExclude(source)).toBe(true);
    });

    it("should exclude windows with negative dimensions", () => {
      const filter = new WindowFilter();

      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: -100, height: 600 },
      };

      expect(filter.shouldExclude(source)).toBe(true);
    });

    it("should not exclude windows with valid dimensions", () => {
      const filter = new WindowFilter();

      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };

      expect(filter.shouldExclude(source)).toBe(false);
    });

    it("should not exclude windows without bounds (unknown state)", () => {
      const filter = new WindowFilter();

      const source: CaptureSource = {
        id: "test-1",
        name: "Test App",
        type: "window",
      };

      expect(filter.shouldExclude(source)).toBe(false);
    });

    it("should never exclude screens regardless of bounds", () => {
      const filter = new WindowFilter();

      const source: CaptureSource = {
        id: "screen-1",
        name: "Screen 1",
        type: "screen",
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      };

      expect(filter.shouldExclude(source)).toBe(false);
    });
  });

  describe("Filter configuration parsing", () => {
    it("should filter using custom system windows", () => {
      const filter = new WindowFilter({
        systemWindows: ["CustomSystemApp"],
      });

      const sources: CaptureSource[] = [
        { id: "1", name: "CustomSystemApp", type: "window" },
        { id: "2", name: "RegularApp", type: "window" },
      ];

      const filtered = filter.filterSystemWindows(sources);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("RegularApp");
    });

    it("should normalize using custom aliases", () => {
      const filter = new WindowFilter({
        appAliases: { "My Canonical App": ["myapp", "ma"] },
      });

      expect(filter.normalizeAppName("myapp")).toBe("My Canonical App");
      expect(filter.normalizeAppName("ma")).toBe("My Canonical App");
      expect(filter.normalizeAppName("unknown")).toBe("unknown");
    });
  });

  describe("Case insensitivity", () => {
    it("should match system windows case-insensitively", () => {
      const filter = new WindowFilter();

      const sources: CaptureSource[] = [
        { id: "1", name: "DOCK", type: "window" },
        { id: "2", name: "dock", type: "window" },
        { id: "3", name: "Dock", type: "window" },
        { id: "4", name: "RegularApp", type: "window" },
      ];

      const filtered = filter.filterSystemWindows(sources);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("RegularApp");
    });

    it("should normalize aliases case-insensitively", () => {
      const filter = new WindowFilter();

      expect(filter.normalizeAppName("CHROME")).toBe("Google Chrome");
      expect(filter.normalizeAppName("Chrome")).toBe("Google Chrome");
      expect(filter.normalizeAppName("chrome")).toBe("Google Chrome");
    });
  });

  describe("Combined filtering with shouldExclude", () => {
    it("should exclude both system windows and minimized windows", () => {
      const filter = new WindowFilter();

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

      expect(filter.shouldExclude(systemWindow)).toBe(true);
      expect(filter.shouldExclude(minimizedWindow)).toBe(true);
      expect(filter.shouldExclude(normalWindow)).toBe(false);
    });
  });
});
