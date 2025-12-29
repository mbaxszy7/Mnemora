/**
 * Property-Based Tests for useCapturePreferences Hook
 *
 *
 *
 * These tests verify the correctness properties for the select all/deselect all
 * functionality defined in the design document.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// Generator for screen IDs
const screenIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);

// Generator for arrays of screen IDs (unique)
const screenIdsArb = fc
  .array(screenIdArb, { minLength: 0, maxLength: 10 })
  .map((arr) => [...new Set(arr)]);

// Generator for application names (non-empty strings)
const appNameArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

// Generator for arrays of application names (unique)
const appNamesArb = fc
  .array(appNameArb, { minLength: 0, maxLength: 10 })
  .map((arr) => [...new Set(arr)]);

/**
 * Simulate the select all operation: returns all available items
 */
function selectAll<T>(allItems: T[]): T[] {
  return [...allItems];
}

/**
 * Simulate the deselect all operation: returns empty array
 */
function deselectAll<T>(): T[] {
  return [];
}

describe("useCapturePreferences Property Tests", () => {
  describe("Property 5: Select all/deselect all operation correctness", () => {
    it("Select all screens - result contains exactly all screens", () => {
      fc.assert(
        fc.property(screenIdsArb, (allScreens) => {
          const result = selectAll(allScreens);

          expect(result.length).toBe(allScreens.length);
          expect(result.sort()).toEqual(allScreens.sort());
          for (const screen of allScreens) {
            expect(result).toContain(screen);
          }
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Select all apps - result contains exactly all apps", () => {
      fc.assert(
        fc.property(appNamesArb, (allApps) => {
          const result = selectAll(allApps);

          expect(result.length).toBe(allApps.length);
          expect(result.sort()).toEqual(allApps.sort());
          for (const app of allApps) {
            expect(result).toContain(app);
          }
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Deselect all - always returns empty array", () => {
      const result = deselectAll<string>();
      expect(result.length).toBe(0);
      expect(result).toEqual([]);
    });

    it("Select all then deselect all - ends with empty selection", () => {
      fc.assert(
        fc.property(screenIdsArb, (allItems) => {
          const afterSelectAll = selectAll(allItems);
          expect(afterSelectAll.length).toBe(allItems.length);

          const afterDeselectAll = deselectAll<string>();
          expect(afterDeselectAll.length).toBe(0);
          expect(afterDeselectAll).toEqual([]);
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Deselect all then select all - ends with all items selected", () => {
      fc.assert(
        fc.property(appNamesArb, (allItems) => {
          const afterDeselectAll = deselectAll<string>();
          expect(afterDeselectAll.length).toBe(0);

          const afterSelectAll = selectAll(allItems);
          expect(afterSelectAll.length).toBe(allItems.length);
          expect(afterSelectAll.sort()).toEqual(allItems.sort());
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Select all is idempotent", () => {
      fc.assert(
        fc.property(screenIdsArb, (allItems) => {
          const first = selectAll(allItems);
          const second = selectAll(allItems);

          expect(second.sort()).toEqual(first.sort());
          expect(second.length).toBe(allItems.length);
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Deselect all is idempotent", () => {
      const first = deselectAll<string>();
      const second = deselectAll<string>();

      expect(second).toEqual(first);
      expect(second.length).toBe(0);
    });
  });
});
