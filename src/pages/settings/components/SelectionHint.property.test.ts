/**
 * Property-Based Tests for Empty Selection Default Behavior
 *
 *
 *
 * For any screen/app list, when selection is empty, the system should
 * behave as "capture all" mode.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { ScreenInfo, AppInfo } from "@shared/capture-source-types";

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

// Generator for AppInfo objects (icon/isPopular computed on frontend using findPopularApp)
const appInfoArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 30 }),
  name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
  type: fc.constant("window" as const),
  appIcon: fc.string({ minLength: 0, maxLength: 100 }),
  windowCount: fc.integer({ min: 1, max: 100 }),
});

/**
 * Determines if the system should show "capture all" hint for screens
 */
function shouldShowCaptureAllScreensHint(
  screens: ScreenInfo[],
  selectedScreenIds: string[]
): boolean {
  // Empty selection means capture all
  return screens.length > 0 && selectedScreenIds.length === 0;
}

/**
 * Determines if the system should show "capture all" hint for apps
 */
function shouldShowCaptureAllAppsHint(apps: AppInfo[], selectedAppNames: string[]): boolean {
  // Empty selection means capture all
  return apps.length > 0 && selectedAppNames.length === 0;
}

/**
 * Gets the effective screens to capture based on selection
 * Empty selection = all screens
 */
function getEffectiveScreens(screens: ScreenInfo[], selectedScreenIds: string[]): ScreenInfo[] {
  if (selectedScreenIds.length === 0) {
    return screens; // Capture all
  }
  return screens.filter((s) => selectedScreenIds.includes(s.id));
}

/**
 * Gets the effective apps to capture based on selection
 * Empty selection = all apps
 */
function getEffectiveApps(apps: AppInfo[], selectedAppNames: string[]): AppInfo[] {
  if (selectedAppNames.length === 0) {
    return apps; // Capture all
  }
  return apps.filter((a) => selectedAppNames.includes(a.name));
}

describe("Selection Hint Property Tests", () => {
  /**
   *
   *
   * For any screen/app list, when selection is empty, the system should
   * behave as "capture all" mode.
   */
  describe("Property 10: Empty selection default behavior", () => {
    it("Empty screen selection should capture all screens", () => {
      fc.assert(
        fc.property(fc.array(screenInfoArb, { minLength: 1, maxLength: 10 }), (screens) => {
          const emptySelection: string[] = [];
          const effectiveScreens = getEffectiveScreens(screens, emptySelection);

          // Property: Empty selection means all screens are captured
          expect(effectiveScreens.length).toBe(screens.length);
          expect(effectiveScreens).toEqual(screens);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Empty app selection should capture all apps", () => {
      fc.assert(
        fc.property(fc.array(appInfoArb, { minLength: 1, maxLength: 10 }), (apps) => {
          const emptySelection: string[] = [];
          const effectiveApps = getEffectiveApps(apps, emptySelection);

          // Property: Empty selection means all apps are captured
          expect(effectiveApps.length).toBe(apps.length);
          expect(effectiveApps).toEqual(apps);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Capture all hint should be shown when screen selection is empty", () => {
      fc.assert(
        fc.property(fc.array(screenInfoArb, { minLength: 1, maxLength: 10 }), (screens) => {
          const emptySelection: string[] = [];
          const showHint = shouldShowCaptureAllScreensHint(screens, emptySelection);

          // Property: Hint should be shown when selection is empty and screens exist
          expect(showHint).toBe(true);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Capture all hint should be shown when app selection is empty", () => {
      fc.assert(
        fc.property(fc.array(appInfoArb, { minLength: 1, maxLength: 10 }), (apps) => {
          const emptySelection: string[] = [];
          const showHint = shouldShowCaptureAllAppsHint(apps, emptySelection);

          // Property: Hint should be shown when selection is empty and apps exist
          expect(showHint).toBe(true);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Capture all hint should NOT be shown when screens are selected", () => {
      fc.assert(
        fc.property(fc.array(screenInfoArb, { minLength: 1, maxLength: 10 }), (screens) => {
          // Select at least one screen
          const selectedIds = [screens[0].id];
          const showHint = shouldShowCaptureAllScreensHint(screens, selectedIds);

          // Property: Hint should NOT be shown when at least one screen is selected
          expect(showHint).toBe(false);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Capture all hint should NOT be shown when apps are selected", () => {
      fc.assert(
        fc.property(fc.array(appInfoArb, { minLength: 1, maxLength: 10 }), (apps) => {
          // Select at least one app
          const selectedNames = [apps[0].name];
          const showHint = shouldShowCaptureAllAppsHint(apps, selectedNames);

          // Property: Hint should NOT be shown when at least one app is selected
          expect(showHint).toBe(false);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Non-empty selection should filter to only selected screens", () => {
      fc.assert(
        fc.property(fc.array(screenInfoArb, { minLength: 2, maxLength: 10 }), (screens) => {
          // Select only the first screen
          const selectedIds = [screens[0].id];
          const effectiveScreens = getEffectiveScreens(screens, selectedIds);

          // Property: Only selected screens should be in effective list
          expect(effectiveScreens.length).toBe(1);
          expect(effectiveScreens[0].id).toBe(screens[0].id);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("Non-empty selection should filter to only selected apps", () => {
      fc.assert(
        fc.property(fc.array(appInfoArb, { minLength: 2, maxLength: 10 }), (apps) => {
          // Select only the first app
          const selectedNames = [apps[0].name];
          const effectiveApps = getEffectiveApps(apps, selectedNames);

          // Property: Only selected apps should be in effective list
          expect(effectiveApps.length).toBe(1);
          expect(effectiveApps[0].name).toBe(apps[0].name);

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});
