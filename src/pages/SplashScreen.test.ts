import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { getNavigationTarget } from "./SplashScreen";

describe("Property 3: Navigation target determination", () => {
  it("returns '/' when status is configured", () => {
    fc.assert(
      fc.property(fc.constant("configured"), (status: "configured") => {
        const target = getNavigationTarget(status);
        expect(target).toBe("/");
      }),
      { numRuns: 100 }
    );
  });

  it("returns '/llm-config' when status is not_configured", () => {
    fc.assert(
      fc.property(fc.constant("not_configured"), (status: "not_configured") => {
        const target = getNavigationTarget(status);
        expect(target).toBe("/llm-config");
      }),
      { numRuns: 100 }
    );
  });

  it("returns '/' when status is unknown (fail-open)", () => {
    fc.assert(
      fc.property(fc.constant("unknown"), (status: "unknown") => {
        const target = getNavigationTarget(status);
        expect(target).toBe("/");
      }),
      { numRuns: 100 }
    );
  });

  it("navigation target is deterministic for any status input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("configured", "not_configured", "unknown"),
        (status: "configured" | "not_configured" | "unknown") => {
          const target = getNavigationTarget(status);
          expect(["/", "/llm-config"]).toContain(target);
          if (status === "not_configured") {
            expect(target).toBe("/llm-config");
            return;
          }
          expect(target).toBe("/");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("navigation target is idempotent - same input always produces same output", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("configured", "not_configured", "unknown"),
        (status: "configured" | "not_configured" | "unknown") => {
          const target1 = getNavigationTarget(status);
          const target2 = getNavigationTarget(status);
          expect(target1).toBe(target2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("defaults unknown-like values to home in wrapper type space", () => {
    fc.assert(
      fc.property(fc.constant("unknown"), (status: "unknown") => {
        const target1 = getNavigationTarget(status);
        const target2 = getNavigationTarget(status);
        expect(target1).toBe(target2);
        expect(target1).toBe("/");
      }),
      { numRuns: 100 }
    );
  });
});
