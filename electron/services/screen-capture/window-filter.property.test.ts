/**
 * Property-Based Tests for WindowFilter
 *
 * These tests verify the correctness properties using fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { windowFilter } from "./window-filter";
import type { CaptureSource } from "./types";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "./types";

const normalizeAppNameForTest = (
  windowFilter as unknown as { normalizeAppName: (name: string) => string }
).normalizeAppName;

// Generator for CaptureSource
const captureSourceArb = (type: "screen" | "window" = "window"): fc.Arbitrary<CaptureSource> =>
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

// Generator for window sources (type = "window")
const windowSourceArb = captureSourceArb("window");

// Generator for screen sources (type = "screen")
const screenSourceArb = captureSourceArb("screen");

describe("WindowFilter Property Tests", () => {
  /**
   *
   */
  it("System window exclusion - all system windows are excluded from result", () => {
    fc.assert(
      fc.property(
        // Generate a list of regular windows
        fc.array(windowSourceArb, { minLength: 0, maxLength: 10 }),
        // Generate system window names to inject
        fc.array(fc.constantFrom(...DEFAULT_WINDOW_FILTER_CONFIG.systemWindows), {
          minLength: 1,
          maxLength: 5,
        }),
        (regularWindows, systemWindowNames) => {
          // Create system window sources
          const systemWindows: CaptureSource[] = systemWindowNames.map((name, i) => ({
            id: `system-${i}`,
            name,
            type: "window" as const,
          }));

          // Combine regular and system windows
          const allSources = [...regularWindows, ...systemWindows];

          // Apply filter
          const filtered = windowFilter.filterSystemWindows(allSources);

          // Property: No system windows should remain in the filtered result
          const systemWindowsLower = new Set(
            DEFAULT_WINDOW_FILTER_CONFIG.systemWindows.map((w) => w.toLowerCase())
          );

          for (const source of filtered) {
            if (source.type === "window") {
              expect(systemWindowsLower.has(source.name.toLowerCase())).toBe(false);
            }
          }

          // Property: All non-system windows should still be present
          const filteredIds = new Set(filtered.map((s) => s.id));
          for (const window of regularWindows) {
            if (!systemWindowsLower.has(window.name.toLowerCase())) {
              expect(filteredIds.has(window.id)).toBe(true);
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   *
   */
  it("App name normalization - aliases resolve to canonical names", () => {
    // Build all alias -> canonical pairs from config
    const aliasPairs: Array<{ alias: string; canonical: string }> = [];
    for (const [canonical, aliases] of Object.entries(DEFAULT_WINDOW_FILTER_CONFIG.appAliases)) {
      for (const alias of aliases) {
        aliasPairs.push({ alias, canonical });
      }
    }

    fc.assert(
      fc.property(
        // Pick a random alias pair
        fc.constantFrom(...aliasPairs),
        // Optionally add case variation
        fc.boolean(),
        ({ alias, canonical }, useUpperCase) => {
          // Apply case variation
          const testAlias = useUpperCase ? alias.toUpperCase() : alias.toLowerCase();

          // Normalize the alias
          const normalized = normalizeAppNameForTest(testAlias);

          // Property: The normalized name should equal the canonical name
          expect(normalized).toBe(canonical);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Additional property: Non-alias names should be returned unchanged
   */
  it("Non-alias names are returned unchanged", () => {
    // Get all known aliases
    const allAliases = new Set<string>();
    for (const aliases of Object.values(DEFAULT_WINDOW_FILTER_CONFIG.appAliases)) {
      for (const alias of aliases) {
        allAliases.add(alias.toLowerCase());
      }
    }

    fc.assert(
      fc.property(
        // Generate random strings that are not aliases
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !allAliases.has(s.toLowerCase())),
        (nonAliasName) => {
          // Normalize the non-alias name
          const normalized = normalizeAppNameForTest(nonAliasName);

          // Property: Non-alias names should be returned unchanged
          expect(normalized).toBe(nonAliasName);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Screens are never filtered out by filterSystemWindows
   */
  it("Screens are preserved by filterSystemWindows", () => {
    fc.assert(
      fc.property(
        // Generate screens
        fc.array(screenSourceArb, { minLength: 1, maxLength: 5 }),
        // Generate windows (some may be system windows)
        fc.array(windowSourceArb, { minLength: 0, maxLength: 10 }),
        (screens, windows) => {
          const allSources = [...screens, ...windows];
          const filtered = windowFilter.filterSystemWindows(allSources);

          // Property: All screens should be preserved
          const filteredIds = new Set(filtered.map((s) => s.id));
          for (const screen of screens) {
            expect(filteredIds.has(screen.id)).toBe(true);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
