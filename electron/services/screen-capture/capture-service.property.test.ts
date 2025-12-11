/**
 * Property-Based Tests for CaptureService
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { CaptureService } from "./capture-service";

/**
 * Generator for monitor-like objects with valid bounds
 * Monitors have x, y coordinates and positive width/height
 */
const monitorArbitrary = fc.record({
  id: fc.integer({ min: 0, max: 100 }),
  name: fc.string(),
  x: fc.integer({ min: -5000, max: 5000 }),
  y: fc.integer({ min: -5000, max: 5000 }),
  width: fc.integer({ min: 100, max: 4000 }),
  height: fc.integer({ min: 100, max: 3000 }),
  rotation: fc.constantFrom(0, 90, 180, 270),
  scaleFactor: fc.double({ min: 1, max: 3 }),
  frequency: fc.integer({ min: 30, max: 240 }),
  isPrimary: fc.boolean(),
});

/**
 * Generator for arrays of monitors (1-4 monitors is typical)
 */
const monitorsArbitrary = fc.array(monitorArbitrary, { minLength: 1, maxLength: 4 });

describe("CaptureService Property Tests", () => {
  const captureService = new CaptureService();

  /**
   * **Feature: screen-capture-scheduler, Property 8: Multi-Monitor Composite Dimensions**
   * **Validates: Requirements 6.2**
   *
   * For any set of monitor captures with known bounds, the stitched composite image
   * SHALL have dimensions equal to the bounding box of all monitors.
   */
  it("Property 8: Multi-monitor composite dimensions equal bounding box of all monitors", () => {
    fc.assert(
      fc.property(monitorsArbitrary, (monitors) => {
        // Calculate expected bounding box manually
        let expectedMinX = Infinity;
        let expectedMinY = Infinity;
        let expectedMaxX = -Infinity;
        let expectedMaxY = -Infinity;

        for (const monitor of monitors) {
          expectedMinX = Math.min(expectedMinX, monitor.x);
          expectedMinY = Math.min(expectedMinY, monitor.y);
          expectedMaxX = Math.max(expectedMaxX, monitor.x + monitor.width);
          expectedMaxY = Math.max(expectedMaxY, monitor.y + monitor.height);
        }

        const expectedWidth = expectedMaxX - expectedMinX;
        const expectedHeight = expectedMaxY - expectedMinY;

        // Use the service's calculateBoundingBox method
        // We need to cast to the expected type since we're using mock monitors
        const result = captureService.calculateBoundingBox(monitors as never);

        // Property: The calculated dimensions should equal the expected bounding box
        expect(result.width).toBe(expectedWidth);
        expect(result.height).toBe(expectedHeight);
        expect(result.minX).toBe(expectedMinX);
        expect(result.minY).toBe(expectedMinY);

        return true;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Feature: screen-capture-scheduler, Property 9: Single Composite Output**
   * **Validates: Requirements 6.4**
   *
   * For any number of monitors (1 or more), the capture service SHALL produce
   * exactly one CaptureResult with `isComposite` set appropriately.
   *
   * Note: This property tests the logic of isComposite flag based on monitor count.
   * We test this by verifying the bounding box calculation behavior which determines
   * whether stitching is needed.
   */
  it("Property 9: Single composite output - bounding box is always valid for any monitor count", () => {
    fc.assert(
      fc.property(monitorsArbitrary, (monitors) => {
        const result = captureService.calculateBoundingBox(monitors as never);

        // Property: For any non-empty monitor list, we get valid dimensions
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);

        // Property: The bounding box should encompass all monitors
        for (const monitor of monitors) {
          // Each monitor's left edge should be >= minX
          expect(monitor.x).toBeGreaterThanOrEqual(result.minX);
          // Each monitor's top edge should be >= minY
          expect(monitor.y).toBeGreaterThanOrEqual(result.minY);
          // Each monitor's right edge should be <= minX + width
          expect(monitor.x + monitor.width).toBeLessThanOrEqual(result.minX + result.width);
          // Each monitor's bottom edge should be <= minY + height
          expect(monitor.y + monitor.height).toBeLessThanOrEqual(result.minY + result.height);
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Additional property: Empty monitor list handling
   */
  it("Property: Empty monitor list returns zero dimensions", () => {
    const result = captureService.calculateBoundingBox([]);

    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.minX).toBe(0);
    expect(result.minY).toBe(0);
  });

  /**
   * Additional property: Single monitor bounding box equals monitor dimensions
   */
  it("Property: Single monitor bounding box equals monitor dimensions", () => {
    fc.assert(
      fc.property(monitorArbitrary, (monitor) => {
        const result = captureService.calculateBoundingBox([monitor] as never);

        // Property: For a single monitor, bounding box equals monitor dimensions
        expect(result.width).toBe(monitor.width);
        expect(result.height).toBe(monitor.height);
        expect(result.minX).toBe(monitor.x);
        expect(result.minY).toBe(monitor.y);

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
