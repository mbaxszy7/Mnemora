/**
 * Property-Based Tests for CaptureService
 *
 * These tests verify the correctness properties for the capture service.
 * After removing multi-monitor stitching, each screen is captured independently.
 */

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { CaptureService } from "./capture-service";

// Mock electron screen module
vi.mock("electron", () => ({
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  },
  desktopCapturer: {
    getSources: vi.fn(() => []),
  },
}));

describe("CaptureService Property Tests", () => {
  const captureService = new CaptureService();

  /**
   * Property: mapScreenIdsToDisplayIds correctly maps IDs
   * For any valid screen info array and selected IDs, the mapping
   * should return the corresponding display IDs.
   */
  it("Property: mapScreenIdsToDisplayIds maps correctly", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            displayId: fc.string({ minLength: 1, maxLength: 10 }),
            name: fc.string(),
            thumbnail: fc.constant(""),
            width: fc.integer({ min: 100, max: 4000 }),
            height: fc.integer({ min: 100, max: 3000 }),
            isPrimary: fc.boolean(),
          }),
          { minLength: 1, maxLength: 4 }
        ),
        (screenInfos) => {
          // Select some screen IDs
          const selectedIds = screenInfos.slice(0, 2).map((s) => s.id);

          // Map them
          const displayIds = captureService.mapScreenIdsToDisplayIds(selectedIds, screenInfos);

          // Verify mapping is correct
          for (let i = 0; i < selectedIds.length; i++) {
            const screenInfo = screenInfos.find((s) => s.id === selectedIds[i]);
            if (screenInfo) {
              expect(displayIds).toContain(screenInfo.displayId);
            }
          }

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: mapScreenIdsToDisplayIds handles missing screens gracefully
   */
  it("Property: mapScreenIdsToDisplayIds handles missing screens", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        (nonExistentIds) => {
          // Empty screen infos - none of the IDs will match
          const displayIds = captureService.mapScreenIdsToDisplayIds(nonExistentIds, []);

          // Should return empty array when no matches
          expect(displayIds).toEqual([]);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});
