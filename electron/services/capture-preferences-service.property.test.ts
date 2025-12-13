/**
 * Property-Based Tests for CapturePreferencesService
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { CapturePreferencesService } from "./capture-preferences-service";
import type { CaptureSource } from "./screen-capture";

// Generator for application names (non-empty strings)
const appNameArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

// Generator for arrays of application names
const appNamesArb = fc.array(appNameArb, { minLength: 0, maxLength: 10 });

// Generator for screen IDs
const screenIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);

// Generator for arrays of screen IDs
const screenIdsArb = fc.array(screenIdArb, { minLength: 0, maxLength: 5 });

/**
 * Helper function to create mock CaptureSource windows from app names
 * Each app name becomes a window with that appName
 */
function createMockWindows(appNames: string[]): CaptureSource[] {
  return appNames.map((appName, index) => ({
    id: `window-${index}`,
    name: `${appName} - Window`,
    type: "window" as const,
    appName,
  }));
}

describe("CapturePreferencesService Property Tests", () => {
  /**
   * **Feature: capture-source-settings, Property 3: 回退模式触发条件**
   * **Validates: Requirements 3.1**
   *
   * For any selected app list and active app list, when and only when their intersection is empty,
   * the system should fallback to all capture mode.
   */
  it("Property 3: App fallback mode trigger condition - fallback occurs when no selected apps are active", () => {
    fc.assert(
      fc.property(
        // Generate selected apps
        appNamesArb,
        // Generate active apps
        appNamesArb,
        // Generate available screens (needed for the unified API)
        screenIdsArb,
        (selectedApps, activeApps, availableScreens) => {
          const service = new CapturePreferencesService();

          // Set preferences with selected apps
          service.setPreferences({ selectedAppNames: selectedApps });

          // Calculate expected fallback condition
          const intersection = selectedApps.filter((app) => activeApps.includes(app));
          const expectedFallback = selectedApps.length > 0 && intersection.length === 0;

          // Create mock windows from active apps
          const windows = createMockWindows(activeApps);

          // Test the actual fallback condition using unified API
          const result = service.getEffectiveCaptureSources(availableScreens, windows);

          // Property: Should fallback if and only if:
          // 1. There are selected apps (selectedApps.length > 0)
          // 2. AND none of the selected apps are active (intersection.length === 0)
          expect(result.appFallback).toBe(expectedFallback);

          // When fallback, should return all active apps
          if (expectedFallback) {
            expect(result.appNames.sort()).toEqual(activeApps.sort());
          } else if (selectedApps.length > 0) {
            // When not fallback and has selection, should return intersection
            expect(result.appNames.sort()).toEqual(intersection.sort());
          } else {
            // When no selection, should return all active apps (not a fallback)
            expect(result.appNames.sort()).toEqual(activeApps.sort());
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3 extension: Screen fallback when selected screens unavailable
   * (e.g., external monitor disconnected)
   */
  it("Property 3 (screens): Screen fallback occurs when selected screens are unavailable", () => {
    fc.assert(
      fc.property(
        // Generate selected screens
        screenIdsArb,
        // Generate available screens
        screenIdsArb,
        // Generate active apps (needed for the unified API)
        appNamesArb,
        (selectedScreens, availableScreens, activeApps) => {
          const service = new CapturePreferencesService();

          // Set preferences with selected screens
          service.setPreferences({ selectedScreenIds: selectedScreens });

          // Calculate expected fallback condition
          const intersection = selectedScreens.filter((id) => availableScreens.includes(id));
          const expectedFallback = selectedScreens.length > 0 && intersection.length === 0;

          // Create mock windows from active apps
          const windows = createMockWindows(activeApps);

          // Test the actual fallback condition
          const result = service.getEffectiveCaptureSources(availableScreens, windows);

          // Property: Should fallback if and only if:
          // 1. There are selected screens (selectedScreens.length > 0)
          // 2. AND none of the selected screens are available (intersection.length === 0)
          expect(result.screenFallback).toBe(expectedFallback);

          // When fallback, should return all available screens
          if (expectedFallback) {
            expect(result.screenIds.sort()).toEqual(availableScreens.sort());
          } else if (selectedScreens.length > 0) {
            // When not fallback and has selection, should return intersection
            expect(result.screenIds.sort()).toEqual(intersection.sort());
          } else {
            // When no selection, should return all available screens (not a fallback)
            expect(result.screenIds.sort()).toEqual(availableScreens.sort());
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Feature: capture-source-settings, Property 4: 选择保留一致性**
   * **Validates: Requirements 4.4**
   *
   * For any refresh before selection state and refresh after active app list,
   * the selection of apps that are still active should be preserved.
   */
  it("Property 4: Selection retention consistency - active apps retain their selection", () => {
    fc.assert(
      fc.property(
        // Generate initial selected apps
        appNamesArb,
        // Generate apps that are active after refresh
        appNamesArb,
        // Generate available screens
        screenIdsArb,
        (initialSelectedApps, appsAfterRefresh, availableScreens) => {
          const service = new CapturePreferencesService();

          // Set initial preferences with selected apps
          service.setPreferences({ selectedAppNames: initialSelectedApps });

          // Simulate the selection retention logic:
          // Apps that were selected AND are still active should remain selected
          const appsStillActive = initialSelectedApps.filter((app) =>
            appsAfterRefresh.includes(app)
          );

          // Create mock windows from apps after refresh
          const windows = createMockWindows(appsAfterRefresh);

          // Get effective capture sources after refresh
          const result = service.getEffectiveCaptureSources(availableScreens, windows);

          if (initialSelectedApps.length === 0) {
            // When no apps were initially selected, should return all active apps
            expect(result.appNames.sort()).toEqual(appsAfterRefresh.sort());
            expect(result.appFallback).toBe(false);
          } else if (appsStillActive.length === 0) {
            // When no selected apps are still active, should fallback to all
            expect(result.appNames.sort()).toEqual(appsAfterRefresh.sort());
            expect(result.appFallback).toBe(true);
          } else {
            // When some selected apps are still active, should return intersection
            expect(result.appNames.sort()).toEqual(appsStillActive.sort());
            expect(result.appFallback).toBe(false);

            // Property: All apps in the effective list should be both:
            // 1. In the original selection
            // 2. In the current active apps list
            for (const app of result.appNames) {
              expect(initialSelectedApps).toContain(app);
              expect(appsAfterRefresh).toContain(app);
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Preferences round-trip consistency (deep copy)
   */
  it("Preferences round-trip consistency with deep copy", () => {
    fc.assert(
      fc.property(
        screenIdsArb,
        appNamesArb,
        fc.boolean(),
        (screenIds, appNames, rememberSelection) => {
          const service = new CapturePreferencesService();

          const originalPrefs = {
            selectedScreenIds: screenIds,
            selectedAppNames: appNames,
            rememberSelection,
          };

          // Set preferences
          service.setPreferences(originalPrefs);

          // Get preferences back
          const retrievedPrefs = service.getPreferences();

          // Should match what we set
          expect(retrievedPrefs.selectedScreenIds.sort()).toEqual(screenIds.sort());
          expect(retrievedPrefs.selectedAppNames.sort()).toEqual(appNames.sort());
          expect(retrievedPrefs.rememberSelection).toBe(rememberSelection);

          // Verify deep copy - mutating retrieved prefs should not affect internal state
          retrievedPrefs.selectedScreenIds.push("mutated-screen");
          retrievedPrefs.selectedAppNames.push("mutated-app");

          const secondRetrieval = service.getPreferences();
          expect(secondRetrieval.selectedScreenIds).not.toContain("mutated-screen");
          expect(secondRetrieval.selectedAppNames).not.toContain("mutated-app");

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Empty selection means capture all (no fallback flag)
   */
  it("Empty selection means capture all without fallback flag", () => {
    fc.assert(
      fc.property(screenIdsArb, appNamesArb, (availableScreens, activeApps) => {
        const service = new CapturePreferencesService();

        // Create mock windows from active apps
        const windows = createMockWindows(activeApps);

        // Default state: no selection
        const result = service.getEffectiveCaptureSources(availableScreens, windows);

        // Should return all available sources
        expect(result.screenIds.sort()).toEqual(availableScreens.sort());
        expect(result.appNames.sort()).toEqual(activeApps.sort());

        // Should NOT be marked as fallback (empty selection is intentional "capture all")
        expect(result.screenFallback).toBe(false);
        expect(result.appFallback).toBe(false);

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
