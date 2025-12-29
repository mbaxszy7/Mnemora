/**
 * Property-based tests for CSS animation presets
 * Tests correctness properties for the view transition system
 */

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { transitionPresets, getTransitionCSS } from "./presets";
import type { TransitionType } from "./types";

// Valid transition types for testing (excluding 'none' which has no CSS)
const animatedTransitionTypes: TransitionType[] = [
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "scale",
];

describe("View Transition Presets", () => {
  /**
   *
   *
   * For any valid transition type, when a navigation is triggered with that type,
   * the system should inject CSS that contains the corresponding keyframe animation.
   */
  test("Transition type maps to correct CSS animation", () => {
    fc.assert(
      fc.property(fc.constantFrom(...animatedTransitionTypes), (type: TransitionType) => {
        const css = getTransitionCSS(type, 300);

        // CSS should not be empty for animated types
        expect(css.length).toBeGreaterThan(0);

        // CSS should contain view-transition pseudo-elements
        expect(css).toContain("::view-transition-old(root)");
        expect(css).toContain("::view-transition-new(root)");

        // CSS should contain @keyframes definitions
        expect(css).toContain("@keyframes");

        // CSS should contain animation property
        expect(css).toContain("animation:");

        return true;
      }),
      { numRuns: 100 }
    );
  });

  test("transitionPresets contains all expected types", () => {
    const expectedTypes: TransitionType[] = [
      "fade",
      "slide-left",
      "slide-right",
      "slide-up",
      "slide-down",
      "scale",
      "none",
    ];

    expectedTypes.forEach((type) => {
      expect(transitionPresets).toHaveProperty(type);
    });
  });

  test("none type returns empty CSS", () => {
    const css = getTransitionCSS("none", 300);
    expect(css).toBe("");
  });

  /**
   *
   *
   * For any positive duration value, when a navigation is triggered with that duration,
   * the injected CSS should contain the duration value in the --transition-duration CSS variable.
   */
  test("Duration is applied to CSS animation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...animatedTransitionTypes),
        fc.integer({ min: 1, max: 5000 }),
        (type: TransitionType, duration: number) => {
          const css = getTransitionCSS(type, duration);

          // CSS should contain the duration variable with the exact value
          expect(css).toContain(`--transition-duration: ${duration}ms`);

          // CSS should reference the variable in animations
          expect(css).toContain("var(--transition-duration)");

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
