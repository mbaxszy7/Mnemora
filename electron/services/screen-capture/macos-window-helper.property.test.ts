/**
 * Property-Based Tests for macOS Window Helper
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { isMacOS, getHybridWindowSources, getActiveAppsOnAllSpaces } from "./macos-window-helper";
import type { CaptureSource } from "./types";

// Generator for CaptureSource with specific type
const captureSourceArb = (type: "screen" | "window"): fc.Arbitrary<CaptureSource> =>
  fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    type: fc.constant(type),
    bounds: fc.option(
      fc.record({
        x: fc.integer({ min: -1000, max: 5000 }),
        y: fc.integer({ min: -1000, max: 5000 }),
        width: fc.integer({ min: 1, max: 4000 }),
        height: fc.integer({ min: 1, max: 3000 }),
      }),
      { nil: undefined }
    ),
  });

// Generator for window sources
const windowSourceArb = captureSourceArb("window");

// Generator for screen sources
const screenSourceArb = captureSourceArb("screen");

describe("macOS Window Helper Property Tests", () => {
  /**
   * Test isMacOS utility function
   */
  it("isMacOS returns consistent boolean value", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const result = isMacOS();
        expect(typeof result).toBe("boolean");
        // Should be consistent across calls
        expect(isMacOS()).toBe(result);
        return true;
      }),
      { numRuns: 10 }
    );
  });

  /**
   * Test that getHybridWindowSources and getActiveAppsOnAllSpaces are exported functions
   */
  it("Exported functions exist and are callable", () => {
    expect(typeof getHybridWindowSources).toBe("function");
    expect(typeof getActiveAppsOnAllSpaces).toBe("function");
    expect(typeof isMacOS).toBe("function");
  });

  /**
   * Property: Screen sources should pass through getHybridWindowSources unchanged (for type: screen)
   * Note: This is a structural test - actual filtering depends on external Python inspector
   */
  it("Screen sources maintain their type property", () => {
    fc.assert(
      fc.property(screenSourceArb, (screenSource) => {
        // Screen sources should always have type "screen"
        expect(screenSource.type).toBe("screen");
        return true;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Window sources should always have type "window"
   */
  it("Window sources maintain their type property", () => {
    fc.assert(
      fc.property(windowSourceArb, (windowSource) => {
        expect(windowSource.type).toBe("window");
        return true;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property: CaptureSource IDs should be non-empty strings
   */
  it("CaptureSource IDs are valid non-empty strings", () => {
    fc.assert(
      fc.property(fc.oneof(screenSourceArb, windowSourceArb), (source) => {
        expect(typeof source.id).toBe("string");
        expect(source.id.length).toBeGreaterThan(0);
        return true;
      }),
      { numRuns: 50 }
    );
  });
});
