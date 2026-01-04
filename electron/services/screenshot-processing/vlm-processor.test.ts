/**
 * VLM Processor Tests
 *
 * Tests for VLMProcessor including:
 * - Unit tests for core functionality
 * - Screenshot metadata completeness
 * - Zod schema validation
 */

import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";

import { __test__ } from "./vlm-processor";
import type { Shard, HistoryPack, ScreenshotWithData, SourceKey } from "./types";
import type { VLMIndexResult } from "./schemas";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock history pack
 */
function createMockHistoryPack(): HistoryPack {
  return {
    recentThreads: [],
    openSegments: [],
    recentEntities: [],
  };
}

/**
 * Create a mock screenshot with data
 */
function createMockScreenshot(
  id: number,
  sourceKey: SourceKey,
  options?: {
    appHint?: string | null;
    windowTitle?: string | null;
    ts?: number;
  }
): ScreenshotWithData {
  return {
    id,
    ts: options?.ts ?? Date.now(),
    sourceKey,
    phash: `hash${id}`,
    filePath: `/tmp/screenshot_${id}.png`,
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    meta: {
      appHint: options?.appHint === null ? undefined : (options?.appHint ?? "TestApp"),
      windowTitle:
        options?.windowTitle === null ? undefined : (options?.windowTitle ?? "Test Window"),
      width: 1920,
      height: 1080,
      bytes: 1024,
      mime: "image/png",
    },
  };
}

/**
 * Create a mock shard
 */
function createMockShard(
  shardIndex: number,
  screenshots: ScreenshotWithData[],
  historyPack?: HistoryPack
): Shard {
  return {
    shardIndex,
    screenshots,
    historyPack: historyPack ?? createMockHistoryPack(),
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("VLMProcessor", () => {
  let processor: ReturnType<typeof __test__.createProcessor>;

  beforeEach(() => {
    processor = __test__.createProcessor();
  });

  describe("buildVLMRequest", () => {
    it("should build request with correct structure", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots = [createMockScreenshot(1, sourceKey), createMockScreenshot(2, sourceKey)];
      const shard = createMockShard(0, screenshots);

      const request = processor.buildVLMRequest(shard);

      expect(request.system).toBeDefined();
      expect(request.system.length).toBeGreaterThan(0);
      expect(request.userContent).toBeDefined();
      expect(request.userContent.length).toBeGreaterThan(0);
    });

    it("should include text prompt as first content item", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots = [createMockScreenshot(1, sourceKey)];
      const shard = createMockShard(0, screenshots);

      const request = processor.buildVLMRequest(shard);

      expect(request.userContent[0].type).toBe("text");
    });

    it("should include images after text prompt", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots = [createMockScreenshot(1, sourceKey), createMockScreenshot(2, sourceKey)];
      const shard = createMockShard(0, screenshots);

      const request = processor.buildVLMRequest(shard);

      // First is text, rest are images
      expect(request.userContent[0].type).toBe("text");
      expect(request.userContent[1].type).toBe("image");
      expect(request.userContent[2].type).toBe("image");
    });
  });

  describe("mergeShardResults", () => {
    it("should return empty result for empty input", () => {
      const result = processor.mergeShardResults([]);

      expect(result.segments).toHaveLength(0);
      expect(result.entities).toHaveLength(0);
      expect(result.screenshots).toHaveLength(0);
    });

    it("should return single result unchanged", () => {
      const singleResult: VLMIndexResult = {
        segments: [
          {
            segment_id: "seg_1",
            screen_ids: [1],
            event: { title: "Test", summary: "Test summary", confidence: 8, importance: 7 },
            derived: { knowledge: [], state: [], procedure: [], plan: [] },
            merge_hint: { decision: "NEW" },
            keywords: ["keyword1"],
          },
        ],
        entities: ["Entity1"],
        screenshots: [
          {
            screenshot_id: 1,
            ocr_text: "ocr",
            ui_text_snippets: ["s1"],
          },
        ],
      };

      const result = processor.mergeShardResults([singleResult]);

      expect(result).toEqual(singleResult);
    });

    it("should merge entities from multiple results", () => {
      const result1: VLMIndexResult = {
        segments: [],
        entities: ["Entity1", "Entity2"],
        screenshots: [],
      };
      const result2: VLMIndexResult = {
        segments: [],
        entities: ["Entity2", "Entity3"],
        screenshots: [],
      };

      const merged = processor.mergeShardResults([result1, result2]);

      expect(merged.entities).toEqual(["Entity1", "Entity2", "Entity3"]);
    });

    it("should deduplicate entities", () => {
      const result1: VLMIndexResult = {
        segments: [],
        entities: ["Entity1", "Entity2"],
        screenshots: [],
      };
      const result2: VLMIndexResult = {
        segments: [],
        entities: ["Entity2", "Entity3"],
        screenshots: [],
      };

      const merged = processor.mergeShardResults([result1, result2]);

      // Should have unique entities only
      const uniqueEntities = new Set(merged.entities);
      expect(uniqueEntities.size).toBe(merged.entities.length);
    });
  });
});

// ============================================================================
// Property Tests
// ============================================================================

describe("VLMProcessor Property Tests", () => {
  /**
   *
   */
  describe("Screenshot metadata completeness", () => {
    it("should include all required metadata fields for each screenshot", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          fc.boolean(),
          fc.boolean(),
          (screenshotCount, hasAppHint, hasWindowTitle) => {
            const sourceKey: SourceKey = "screen:test";
            const screenshots = Array.from({ length: screenshotCount }, (_, i) =>
              createMockScreenshot(i + 1, sourceKey, {
                appHint: hasAppHint ? `App${i}` : null,
                windowTitle: hasWindowTitle ? `Window${i}` : null,
                ts: Date.now() + i * 1000,
              })
            );
            const shard = createMockShard(0, screenshots);

            const processor = __test__.createProcessor();
            const request = processor.buildVLMRequest(shard);

            // Extract text content
            const textContent = request.userContent.find((c) => c.type === "text");
            expect(textContent).toBeDefined();

            const text = (textContent as { type: "text"; text: string }).text;

            // Verify metadata is present in the prompt
            for (let i = 0; i < screenshotCount; i++) {
              // screenshot_id must be present
              expect(text).toContain(`"screenshot_id": ${i + 1}`);

              // captured_at must be present (ISO format)
              expect(text).toMatch(/"captured_at":\s*"\d{4}-\d{2}-\d{2}T/);

              // source_key must be present
              expect(text).toContain(`"source_key": "${sourceKey}"`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should pass null for missing app_hint, not fabricate values", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 5 }), (screenshotCount) => {
          const sourceKey: SourceKey = "screen:test";
          const screenshots = Array.from({ length: screenshotCount }, (_, i) =>
            createMockScreenshot(i + 1, sourceKey, {
              appHint: null, // Explicitly no app hint
              windowTitle: null,
            })
          );
          const shard = createMockShard(0, screenshots);

          const processor = __test__.createProcessor();
          const request = processor.buildVLMRequest(shard);

          const textContent = request.userContent.find((c) => c.type === "text");
          const text = (textContent as { type: "text"; text: string }).text;

          // Should contain null for app_hint, not a fabricated value
          expect(text).toContain('"app_hint": null');
          expect(text).toContain('"window_title": null');
        }),
        { numRuns: 100 }
      );
    });

    it("should preserve actual app_hint and window_title when available", () => {
      fc.assert(
        fc.property(
          // Use alphanumeric strings to avoid JSON escaping issues
          fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/),
          fc.stringMatching(/^[a-zA-Z0-9]{1,50}$/),
          (appHint, windowTitle) => {
            const sourceKey: SourceKey = "window:test";
            const screenshot = createMockScreenshot(1, sourceKey, {
              appHint,
              windowTitle,
            });
            const shard = createMockShard(0, [screenshot]);

            const processor = __test__.createProcessor();
            const request = processor.buildVLMRequest(shard);

            const textContent = request.userContent.find((c) => c.type === "text");
            const text = (textContent as { type: "text"; text: string }).text;

            // Parse the JSON metadata from the text to verify values
            const metaMatch = text.match(
              /## Screenshot Metadata \(order = screen_id\)\n(\[[\s\S]*?\])/
            );
            if (!metaMatch) {
              throw new Error(`Could not find metadata in prompt:\n${text}`);
            }

            const metadata = JSON.parse(metaMatch[1]);
            expect(metadata[0].app_hint).toBe(appHint);
            expect(metadata[0].window_title).toBe(windowTitle);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
