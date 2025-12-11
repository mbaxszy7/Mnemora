/**
 * Property-Based Tests for macOS Window Helper
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mergeSources } from "./macos-window-helper";
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

// Generator for mixed sources
const mixedSourcesArb = fc
  .tuple(
    fc.array(screenSourceArb, { minLength: 0, maxLength: 3 }),
    fc.array(windowSourceArb, { minLength: 0, maxLength: 5 })
  )
  .map(([screens, windows]) => [...screens, ...windows]);

describe("macOS Window Helper Property Tests", () => {
  /**
   * **Feature: screen-capture-scheduler, Property 13: Source List Merging**
   * **Validates: Requirements 8.2**
   *
   * For any two lists of capture sources (e.g., from Electron and AppleScript),
   * the merged result SHALL contain all unique sources from both lists without duplicates.
   */
  it("Property 13: Source list merging - merged result contains all unique sources without duplicates", () => {
    fc.assert(
      fc.property(
        // Generate two lists of sources (simulating Electron and AppleScript sources)
        mixedSourcesArb,
        mixedSourcesArb,
        (electronSources, appleScriptSources) => {
          const merged = mergeSources(electronSources, appleScriptSources);

          // Property 1: All sources from electronSources should be in merged result
          const mergedKeys = new Set(merged.map((s) => `${s.type}:${s.name.toLowerCase().trim()}`));
          for (const source of electronSources) {
            const key = `${source.type}:${source.name.toLowerCase().trim()}`;
            expect(mergedKeys.has(key)).toBe(true);
          }

          // Property 2: All unique sources from appleScriptSources should be in merged result
          //   const electronKeys = new Set(
          //     electronSources.map((s) => `${s.type}:${s.name.toLowerCase().trim()}`)
          //   );
          for (const source of appleScriptSources) {
            const key = `${source.type}:${source.name.toLowerCase().trim()}`;
            // If not already in electron sources, it should be in merged
            expect(mergedKeys.has(key)).toBe(true);
          }

          // Property 3: No duplicates in merged result (by normalized key)
          const seenKeys = new Set<string>();
          for (const source of merged) {
            const key = `${source.type}:${source.name.toLowerCase().trim()}`;
            expect(seenKeys.has(key)).toBe(false);
            seenKeys.add(key);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Additional property: Electron sources take precedence over AppleScript sources
   * (they have proper IDs for capture)
   */
  it("Property 13 (additional): Electron sources take precedence for duplicates", () => {
    fc.assert(
      fc.property(
        // Generate a source that will appear in both lists
        windowSourceArb,
        (sharedSource) => {
          // Create electron version with electron-specific ID
          const electronSource: CaptureSource = {
            ...sharedSource,
            id: `window:electron-${sharedSource.id}`,
          };

          // Create AppleScript version with applescript-specific ID
          const appleScriptSource: CaptureSource = {
            ...sharedSource,
            id: `applescript:${sharedSource.id}`,
          };

          const merged = mergeSources([electronSource], [appleScriptSource]);

          // Property: The merged result should contain the Electron version
          expect(merged.length).toBe(1);
          expect(merged[0].id).toBe(electronSource.id);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Additional property: Merging with empty lists
   */
  it("Property 13 (additional): Merging with empty lists works correctly", () => {
    fc.assert(
      fc.property(mixedSourcesArb, (sources) => {
        // Merging with empty AppleScript sources returns all Electron sources
        const mergedWithEmptyAS = mergeSources(sources, []);
        expect(mergedWithEmptyAS.length).toBe(sources.length);

        // Merging empty Electron sources with AppleScript sources returns all AppleScript sources
        const mergedWithEmptyElectron = mergeSources([], sources);
        expect(mergedWithEmptyElectron.length).toBe(sources.length);

        // Merging two empty lists returns empty
        const mergedEmpty = mergeSources([], []);
        expect(mergedEmpty.length).toBe(0);

        return true;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Additional property: Merge is idempotent when applied to same sources
   */
  it("Merging same sources twice gives same result", () => {
    fc.assert(
      fc.property(mixedSourcesArb, (sources) => {
        const firstMerge = mergeSources(sources, sources);
        const secondMerge = mergeSources(firstMerge, sources);

        // Property: Merging again should not change the result
        expect(secondMerge.length).toBe(firstMerge.length);

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
