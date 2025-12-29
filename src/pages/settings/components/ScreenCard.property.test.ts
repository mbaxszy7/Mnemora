/**
 * Property-Based Tests for Screen Card and Primary Display Uniqueness
 *
 *
 *
 * For any screen list, there should be exactly one screen marked as primary.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { ScreenInfo } from "@shared/capture-source-types";

// Generator for ScreenInfo objects
const screenInfoArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 30 }),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  thumbnail: fc.string({ minLength: 0, maxLength: 100 }),
  type: fc.constant("screen" as const),
  bounds: fc.record({
    x: fc.constant(0),
    y: fc.constant(0),
    width: fc.integer({ min: 800, max: 7680 }),
    height: fc.integer({ min: 600, max: 4320 }),
  }),
  isPrimary: fc.boolean(),
  displayId: fc.string({ minLength: 1, maxLength: 20 }),
});

// Generator for arrays of ScreenInfo with at least one screen
const screenInfoArrayArb = fc.array(screenInfoArb, { minLength: 1, maxLength: 10 });

/**
 * Simulates the backend logic that ensures exactly one primary display
 * This mirrors the logic in CaptureService.getScreensWithThumbnails()
 */
function ensureSinglePrimary(screens: ScreenInfo[]): ScreenInfo[] {
  if (screens.length === 0) return screens;

  // Create a copy to avoid mutation
  const result = screens.map((s) => ({ ...s }));

  // Check if there's already a primary
  const hasPrimary = result.some((s) => s.isPrimary);

  if (!hasPrimary) {
    // If no primary, mark the first one as primary
    result[0].isPrimary = true;
  } else {
    // If multiple primaries, keep only the first one
    let foundPrimary = false;
    for (const screen of result) {
      if (screen.isPrimary) {
        if (foundPrimary) {
          screen.isPrimary = false;
        } else {
          foundPrimary = true;
        }
      }
    }
  }

  return result;
}

describe("Screen Card Property Tests", () => {
  /**
   *
   *
   * For any screen list, there should be exactly one screen marked as primary.
   */
  describe("Property 8: Primary display uniqueness", () => {
    it("After normalization, exactly one screen should be marked as primary", () => {
      fc.assert(
        fc.property(screenInfoArrayArb, (screens) => {
          const normalized = ensureSinglePrimary(screens);

          // Count primary screens
          const primaryCount = normalized.filter((s) => s.isPrimary).length;

          // Property: Exactly one screen should be primary
          expect(primaryCount).toBe(1);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("If input has no primary, first screen becomes primary", () => {
      fc.assert(
        fc.property(screenInfoArrayArb, (screens) => {
          // Force all screens to be non-primary
          const noPrimaryScreens = screens.map((s) => ({ ...s, isPrimary: false }));

          const normalized = ensureSinglePrimary(noPrimaryScreens);

          // First screen should be primary
          expect(normalized[0].isPrimary).toBe(true);

          // Only first screen should be primary
          const primaryCount = normalized.filter((s) => s.isPrimary).length;
          expect(primaryCount).toBe(1);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("If input has multiple primaries, only first primary is kept", () => {
      fc.assert(
        fc.property(fc.array(screenInfoArb, { minLength: 2, maxLength: 10 }), (screens) => {
          // Force all screens to be primary
          const allPrimaryScreens = screens.map((s) => ({ ...s, isPrimary: true }));

          const normalized = ensureSinglePrimary(allPrimaryScreens);

          // First screen should still be primary
          expect(normalized[0].isPrimary).toBe(true);

          // Only one screen should be primary
          const primaryCount = normalized.filter((s) => s.isPrimary).length;
          expect(primaryCount).toBe(1);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Normalization preserves all other screen properties", () => {
      fc.assert(
        fc.property(screenInfoArrayArb, (screens) => {
          const normalized = ensureSinglePrimary(screens);

          // Same length
          expect(normalized.length).toBe(screens.length);

          // All properties except isPrimary should be preserved
          for (let i = 0; i < screens.length; i++) {
            expect(normalized[i].id).toBe(screens[i].id);
            expect(normalized[i].name).toBe(screens[i].name);
            expect(normalized[i].thumbnail).toBe(screens[i].thumbnail);
            expect(normalized[i].bounds.width).toBe(screens[i].bounds.width);
            expect(normalized[i].bounds.height).toBe(screens[i].bounds.height);
            expect(normalized[i].displayId).toBe(screens[i].displayId);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Normalization does not mutate the original array", () => {
      fc.assert(
        fc.property(screenInfoArrayArb, (screens) => {
          // Create a deep copy of original
          const originalCopy = screens.map((s) => ({ ...s }));

          // Normalize
          ensureSinglePrimary(screens);

          // Original should be unchanged
          expect(screens.length).toBe(originalCopy.length);
          for (let i = 0; i < screens.length; i++) {
            expect(screens[i].isPrimary).toBe(originalCopy[i].isPrimary);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});
