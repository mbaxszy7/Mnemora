/**
 * Property-Based Tests for CaptureSourceProvider
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { CaptureSourceProvider } from "./capture-source-provider";
import type { CaptureSource, CaptureSourceFilter } from "./types";

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

// Generator for mixed capture sources (screens and windows)
const mixedSourcesArb = fc
  .tuple(
    fc.array(captureSourceArb("screen"), { minLength: 0, maxLength: 5 }),
    fc.array(captureSourceArb("window"), { minLength: 0, maxLength: 10 })
  )
  .map(([screens, windows]) => [...screens, ...windows]);

describe("CaptureSourceProvider Property Tests", () => {
  /**
   * **Feature: screen-capture-scheduler, Property 6: Source Filtering by Type**
   * **Validates: Requirements 4.2**
   *
   * For any list of capture sources and filter type (screen/window),
   * the filtered result SHALL contain only sources matching that type.
   */
  it("Property 6: Source filtering by type - filtered results contain only matching types", () => {
    fc.assert(
      fc.property(
        // Generate mixed sources (screens and windows)
        mixedSourcesArb,
        // Generate filter type
        fc.constantFrom("screen", "window") as fc.Arbitrary<"screen" | "window">,
        (sources, filterType) => {
          // Create a provider instance (we'll test the filterSources method directly)
          const provider = new CaptureSourceProvider({ immediate: false });

          try {
            const filter: CaptureSourceFilter = { type: filterType };
            const filtered = provider.filterSources(sources, filter);

            // Property 1: All filtered results must match the requested type
            for (const source of filtered) {
              expect(source.type).toBe(filterType);
            }

            // Property 2: All sources of the requested type should be in the result
            const filteredIds = new Set(filtered.map((s) => s.id));
            for (const source of sources) {
              if (source.type === filterType) {
                expect(filteredIds.has(source.id)).toBe(true);
              }
            }

            // Property 3: No sources of other types should be in the result
            for (const source of filtered) {
              expect(source.type).not.toBe(filterType === "screen" ? "window" : "screen");
            }

            return true;
          } finally {
            provider.dispose();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Additional property: Filter with type "all" returns all sources
   */
  it("Property 6 (additional): Filter with type 'all' returns all sources", () => {
    fc.assert(
      fc.property(mixedSourcesArb, (sources) => {
        const provider = new CaptureSourceProvider({ immediate: false });

        try {
          const filter: CaptureSourceFilter = { type: "all" };
          const filtered = provider.filterSources(sources, filter);

          // Property: All sources should be returned
          expect(filtered.length).toBe(sources.length);

          const filteredIds = new Set(filtered.map((s) => s.id));
          for (const source of sources) {
            expect(filteredIds.has(source.id)).toBe(true);
          }

          return true;
        } finally {
          provider.dispose();
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Additional property: Empty filter returns all sources
   */
  it("Property 6 (additional): Empty filter returns all sources", () => {
    fc.assert(
      fc.property(mixedSourcesArb, (sources) => {
        const provider = new CaptureSourceProvider({ immediate: false });

        try {
          const filtered = provider.filterSources(sources, {});

          // Property: All sources should be returned when no filter is specified
          expect(filtered.length).toBe(sources.length);

          return true;
        } finally {
          provider.dispose();
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Filtering is idempotent - filtering twice gives same result
   */
  it("Filtering is idempotent", () => {
    fc.assert(
      fc.property(
        mixedSourcesArb,
        fc.constantFrom("screen", "window") as fc.Arbitrary<"screen" | "window">,
        (sources, filterType) => {
          const provider = new CaptureSourceProvider({ immediate: false });

          try {
            const filter: CaptureSourceFilter = { type: filterType };
            const firstFilter = provider.filterSources(sources, filter);
            const secondFilter = provider.filterSources(firstFilter, filter);

            // Property: Filtering twice should give the same result
            expect(secondFilter.length).toBe(firstFilter.length);
            expect(secondFilter.map((s) => s.id).sort()).toEqual(
              firstFilter.map((s) => s.id).sort()
            );

            return true;
          } finally {
            provider.dispose();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
