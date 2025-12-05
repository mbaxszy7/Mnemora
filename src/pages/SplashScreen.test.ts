import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { getNavigationTarget } from "./SplashScreen";

/**
 * Feature: llm-configuration, Property 3: Navigation target determination
 * Validates: Requirements 1.2, 1.3, 5.4, 8.3
 *
 * For any configuration check result, the navigation function SHALL return
 * '/llm-config' when configured is false, and '/' when configured is true.
 */
describe("Property 3: Navigation target determination", () => {
  it("returns '/' when configured is true", () => {
    fc.assert(
      fc.property(fc.constant(true), (configured: boolean) => {
        const target = getNavigationTarget(configured);
        expect(target).toBe("/");
      }),
      { numRuns: 100 }
    );
  });

  it("returns '/llm-config' when configured is false", () => {
    fc.assert(
      fc.property(fc.constant(false), (configured: boolean) => {
        const target = getNavigationTarget(configured);
        expect(target).toBe("/llm-config");
      }),
      { numRuns: 100 }
    );
  });

  it("navigation target is deterministic for any boolean input", () => {
    fc.assert(
      fc.property(fc.boolean(), (configured: boolean) => {
        const target = getNavigationTarget(configured);
        // Target should always be one of the two valid paths
        expect(["/", "/llm-config"]).toContain(target);
        // Target should be consistent with configured state
        if (configured) {
          expect(target).toBe("/");
        } else {
          expect(target).toBe("/llm-config");
        }
      }),
      { numRuns: 100 }
    );
  });

  it("navigation target is idempotent - same input always produces same output", () => {
    fc.assert(
      fc.property(fc.boolean(), (configured: boolean) => {
        const target1 = getNavigationTarget(configured);
        const target2 = getNavigationTarget(configured);
        expect(target1).toBe(target2);
      }),
      { numRuns: 100 }
    );
  });
});
