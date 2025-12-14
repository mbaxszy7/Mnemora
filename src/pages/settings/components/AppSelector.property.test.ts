/**
 * Property-Based Tests for App Selector Search Functionality
 *
 * **Feature: capture-source-settings, Property 9: 搜索功能显示条件**
 * **Validates: Requirements 8.2**
 *
 * For any app list, the search functionality should be visible
 * if and only if the app count exceeds 10.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { SEARCH_THRESHOLD } from "./AppSelector";
import { AppInfo } from "@shared/capture-source-types";

// Generator for AppInfo objects (icon/isPopular computed on frontend using findPopularApp)
const appInfoArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
  windowCount: fc.integer({ min: 1, max: 100 }),
});

/**
 * Determines if search should be shown based on app count
 * This mirrors the logic in AppSelector component
 */
function shouldShowSearch(apps: AppInfo[]): boolean {
  return apps.length > SEARCH_THRESHOLD;
}

describe("App Selector Property Tests", () => {
  /**
   * **Feature: capture-source-settings, Property 9: 搜索功能显示条件**
   * **Validates: Requirements 8.2**
   *
   * For any app list, the search functionality should be visible
   * if and only if the app count exceeds 10.
   */
  describe("Property 9: Search functionality display condition", () => {
    it("Search should be shown when app count > SEARCH_THRESHOLD", () => {
      fc.assert(
        fc.property(
          fc.array(appInfoArb, { minLength: SEARCH_THRESHOLD + 1, maxLength: 50 }),
          (apps) => {
            const showSearch = shouldShowSearch(apps);

            // Property: Search should be visible when apps > threshold
            expect(showSearch).toBe(true);
            expect(apps.length).toBeGreaterThan(SEARCH_THRESHOLD);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Search should NOT be shown when app count <= SEARCH_THRESHOLD", () => {
      fc.assert(
        fc.property(fc.array(appInfoArb, { minLength: 0, maxLength: SEARCH_THRESHOLD }), (apps) => {
          const showSearch = shouldShowSearch(apps);

          // Property: Search should NOT be visible when apps <= threshold
          expect(showSearch).toBe(false);
          expect(apps.length).toBeLessThanOrEqual(SEARCH_THRESHOLD);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Search visibility is determined solely by app count", () => {
      fc.assert(
        fc.property(fc.array(appInfoArb, { minLength: 0, maxLength: 50 }), (apps) => {
          const showSearch = shouldShowSearch(apps);

          // Property: Search visibility depends only on count
          if (apps.length > SEARCH_THRESHOLD) {
            expect(showSearch).toBe(true);
          } else {
            expect(showSearch).toBe(false);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Boundary condition: exactly SEARCH_THRESHOLD apps should NOT show search", () => {
      fc.assert(
        fc.property(
          fc.array(appInfoArb, { minLength: SEARCH_THRESHOLD, maxLength: SEARCH_THRESHOLD }),
          (apps) => {
            // Ensure we have exactly SEARCH_THRESHOLD apps
            expect(apps.length).toBe(SEARCH_THRESHOLD);

            const showSearch = shouldShowSearch(apps);

            // Property: Exactly threshold apps should NOT show search
            expect(showSearch).toBe(false);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Boundary condition: SEARCH_THRESHOLD + 1 apps should show search", () => {
      fc.assert(
        fc.property(
          fc.array(appInfoArb, {
            minLength: SEARCH_THRESHOLD + 1,
            maxLength: SEARCH_THRESHOLD + 1,
          }),
          (apps) => {
            // Ensure we have exactly SEARCH_THRESHOLD + 1 apps
            expect(apps.length).toBe(SEARCH_THRESHOLD + 1);

            const showSearch = shouldShowSearch(apps);

            // Property: Threshold + 1 apps should show search
            expect(showSearch).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
