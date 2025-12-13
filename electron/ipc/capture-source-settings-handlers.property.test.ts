/**
 * Property-Based Tests for Capture Source Settings Handlers
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  POPULAR_APPS,
  findPopularApp,
  DEFAULT_APP_ICON,
  type PopularAppConfig,
} from "../../shared/popular-apps";
import { CapturePreferencesService } from "../services/capture-preferences-service";

// Get all popular app names and aliases for testing
const popularAppNames = Object.keys(POPULAR_APPS);
const allPopularAliases = Object.values(POPULAR_APPS).flatMap(
  (config: PopularAppConfig) => config.aliases
);

// Generator for popular app names (primary names)
const popularAppNameArb = fc.constantFrom(...popularAppNames);

// Generator for popular app aliases
const popularAppAliasArb = fc.constantFrom(...allPopularAliases);

// Generator for non-popular app names (random strings that don't match any popular app)
const nonPopularAppNameArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  // Ensure it doesn't match any popular app
  return findPopularApp(trimmed) === null;
});

// Generator for AppInfo objects
const appInfoArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
  icon: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 20 })),
  isPopular: fc.boolean(),
  windowCount: fc.integer({ min: 1, max: 100 }),
});

// Generator for arrays of AppInfo
const appInfoArrayArb = fc.array(appInfoArb, { minLength: 0, maxLength: 20 });

describe("Capture Source Settings Handlers Property Tests", () => {
  /**
   * **Feature: capture-source-settings, Property 2: 应用图标匹配正确性**
   * **Validates: Requirements 2.2, 2.5**
   *
   * For any application name, if the app is in the popular apps list (including alias matching),
   * it should return the predefined icon; otherwise return the default icon.
   */
  describe("Property 2: App icon matching correctness", () => {
    it("Popular app primary names should return their predefined icon", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(popularAppNameArb, (appName) => {
          const result = service.matchAppIcon(appName);

          // Should be marked as popular
          expect(result.isPopular).toBe(true);

          // Should return the predefined icon (not the default)
          expect(result.icon).not.toBe(DEFAULT_APP_ICON);

          // Should match the icon defined in POPULAR_APPS
          const expectedIcon = POPULAR_APPS[appName].icon;
          expect(result.icon).toBe(expectedIcon);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Popular app aliases should return their predefined icon", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(popularAppAliasArb, (alias) => {
          const result = service.matchAppIcon(alias);

          // Should be marked as popular
          expect(result.isPopular).toBe(true);

          // Should return the predefined icon (not the default)
          expect(result.icon).not.toBe(DEFAULT_APP_ICON);

          // Find the primary app name for this alias
          const popularApp = findPopularApp(alias);
          expect(popularApp).not.toBeNull();

          // Should match the icon defined for the primary app
          if (popularApp) {
            expect(result.icon).toBe(popularApp.config.icon);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Non-popular app names should return the default icon", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(nonPopularAppNameArb, (appName) => {
          const result = service.matchAppIcon(appName);

          // Should NOT be marked as popular
          expect(result.isPopular).toBe(false);

          // Should return the default icon
          expect(result.icon).toBe(DEFAULT_APP_ICON);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Icon matching is consistent - same input always produces same output", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
          (appName) => {
            const result1 = service.matchAppIcon(appName);
            const result2 = service.matchAppIcon(appName);

            // Same input should always produce same output
            expect(result1.icon).toBe(result2.icon);
            expect(result1.isPopular).toBe(result2.isPopular);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * **Feature: capture-source-settings, Property 6: 流行应用排序正确性**
   * **Validates: Requirements 8.1**
   *
   * For any mixed app list (containing popular and non-popular apps),
   * after sorting, all popular apps should come before non-popular apps.
   */
  describe("Property 6: Popular app sorting correctness", () => {
    it("All popular apps should come before non-popular apps after sorting", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(appInfoArrayArb, (apps) => {
          const sorted = service.sortApps(apps);

          // Find the index of the last popular app and first non-popular app
          let lastPopularIndex = -1;
          let firstNonPopularIndex = sorted.length;

          for (let i = 0; i < sorted.length; i++) {
            if (sorted[i].isPopular) {
              lastPopularIndex = i;
            } else if (firstNonPopularIndex === sorted.length) {
              firstNonPopularIndex = i;
            }
          }

          // Property: All popular apps should come before all non-popular apps
          // This means lastPopularIndex < firstNonPopularIndex
          if (lastPopularIndex !== -1 && firstNonPopularIndex !== sorted.length) {
            expect(lastPopularIndex).toBeLessThan(firstNonPopularIndex);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Sorting preserves all elements (no elements lost or added)", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(appInfoArrayArb, (apps) => {
          const sorted = service.sortApps(apps);

          // Same length
          expect(sorted.length).toBe(apps.length);

          // All original elements are present
          const originalNames = apps.map((a) => a.name).sort();
          const sortedNames = sorted.map((a) => a.name).sort();
          expect(sortedNames).toEqual(originalNames);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Sorting is stable for apps with same popularity - alphabetical order", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(appInfoArrayArb, (apps) => {
          const sorted = service.sortApps(apps);

          // Check that within each group (popular/non-popular), apps are sorted alphabetically
          const popularApps = sorted.filter((a) => a.isPopular);
          const nonPopularApps = sorted.filter((a) => !a.isPopular);

          // Popular apps should be alphabetically sorted
          for (let i = 1; i < popularApps.length; i++) {
            expect(popularApps[i - 1].name.localeCompare(popularApps[i].name)).toBeLessThanOrEqual(
              0
            );
          }

          // Non-popular apps should be alphabetically sorted
          for (let i = 1; i < nonPopularApps.length; i++) {
            expect(
              nonPopularApps[i - 1].name.localeCompare(nonPopularApps[i].name)
            ).toBeLessThanOrEqual(0);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Sorting does not mutate the original array", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(appInfoArrayArb, (apps) => {
          // Create a deep copy of original
          const originalCopy = apps.map((a) => ({ ...a }));

          // Sort
          service.sortApps(apps);

          // Original should be unchanged
          expect(apps.length).toBe(originalCopy.length);
          for (let i = 0; i < apps.length; i++) {
            expect(apps[i].name).toBe(originalCopy[i].name);
            expect(apps[i].isPopular).toBe(originalCopy[i].isPopular);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Sorting is idempotent - sorting twice produces same result", () => {
      const service = new CapturePreferencesService();

      fc.assert(
        fc.property(appInfoArrayArb, (apps) => {
          const sorted1 = service.sortApps(apps);
          const sorted2 = service.sortApps(sorted1);

          // Sorting twice should produce the same result
          expect(sorted2.length).toBe(sorted1.length);
          for (let i = 0; i < sorted1.length; i++) {
            expect(sorted2[i].name).toBe(sorted1[i].name);
            expect(sorted2[i].isPopular).toBe(sorted1[i].isPopular);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});
