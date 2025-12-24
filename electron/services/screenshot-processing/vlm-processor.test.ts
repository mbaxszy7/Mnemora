/**
 * VLM Processor Tests
 *
 * Tests for VLMProcessor including:
 * - Unit tests for core functionality
 * - CP-5: Screenshot metadata completeness
 * - CP-7: Zod schema validation
 */

import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";

import { __test__, VLMParseError } from "./vlm-processor";
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

/**
 * Create a valid VLM response JSON string
 */
function createValidVLMResponse(options?: { segmentCount?: number; entityCount?: number }): string {
  const segmentCount = options?.segmentCount ?? 1;
  const entityCount = options?.entityCount ?? 2;

  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    segment_id: `seg_${i + 1}`,
    screen_ids: [i + 1],
    event: {
      title: `Event ${i + 1}`,
      summary: `Summary for event ${i + 1}`,
      confidence: 8,
      importance: 7,
    },
    derived: {
      knowledge: [],
      state: [],
      procedure: [],
      plan: [],
    },
    merge_hint: {
      decision: "NEW",
    },
    keywords: [`keyword${i + 1}`],
  }));

  const entities = Array.from({ length: entityCount }, (_, i) => `Entity${i + 1}`);

  return JSON.stringify({
    segments,
    entities,
    notes: "Test response",
  });
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

  describe("parseVLMResponse", () => {
    it("should parse valid JSON response", () => {
      const validResponse = createValidVLMResponse();
      const result = processor.parseVLMResponse(validResponse);

      expect(result.segments).toHaveLength(1);
      expect(result.entities).toHaveLength(2);
    });

    it("should parse JSON wrapped in markdown code block", () => {
      const validResponse = createValidVLMResponse();
      const wrappedResponse = "```json\n" + validResponse + "\n```";

      const result = processor.parseVLMResponse(wrappedResponse);

      expect(result.segments).toHaveLength(1);
    });

    it("should throw VLMParseError for invalid JSON", () => {
      const invalidResponse = "This is not JSON at all";

      expect(() => processor.parseVLMResponse(invalidResponse)).toThrow(VLMParseError);
    });

    it("should throw VLMParseError for schema validation failure", () => {
      const invalidSchema = JSON.stringify({
        segments: [
          {
            // Missing required fields
            segment_id: "seg_1",
          },
        ],
      });

      expect(() => processor.parseVLMResponse(invalidSchema)).toThrow(VLMParseError);
    });
  });

  describe("repairVLMResponse", () => {
    it("should remove markdown code blocks", () => {
      const input = '```json\n{"test": true}\n```';
      const result = processor.repairVLMResponse(input);

      expect(result).not.toContain("```");
    });

    it("should fix trailing commas", () => {
      const input = '{"items": [1, 2, 3,]}';
      const result = processor.repairVLMResponse(input);

      expect(result).toBe('{"items": [1, 2, 3]}');
    });

    it("should convert single quotes to double quotes", () => {
      const input = "{'key': 'value'}";
      const result = processor.repairVLMResponse(input);

      expect(result).toContain('"key"');
      expect(result).toContain('"value"');
    });
  });

  describe("mergeShardResults", () => {
    it("should return empty result for empty input", () => {
      const result = processor.mergeShardResults([]);

      expect(result.segments).toHaveLength(0);
      expect(result.entities).toHaveLength(0);
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
          },
        ],
        entities: ["Entity1"],
      };

      const result = processor.mergeShardResults([singleResult]);

      expect(result).toEqual(singleResult);
    });

    it("should merge entities from multiple results", () => {
      const result1: VLMIndexResult = {
        segments: [],
        entities: ["Entity1", "Entity2"],
      };
      const result2: VLMIndexResult = {
        segments: [],
        entities: ["Entity2", "Entity3"],
      };

      const merged = processor.mergeShardResults([result1, result2]);

      expect(merged.entities).toContain("Entity1");
      expect(merged.entities).toContain("Entity2");
      expect(merged.entities).toContain("Entity3");
    });

    it("should deduplicate entities", () => {
      const result1: VLMIndexResult = {
        segments: [],
        entities: ["Entity1", "Entity2"],
      };
      const result2: VLMIndexResult = {
        segments: [],
        entities: ["Entity2", "Entity3"],
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
   * CP-5: Screenshot metadata completeness
   *
   * Property: For any VLM request, each screenshot must include:
   * - screenshot_id (non-null)
   * - captured_at (non-null, valid ISO string)
   * - source_key (non-null)
   * - app_hint (null or string, never fabricated)
   * - window_title (null or string, never fabricated)
   *
   * **Feature: screenshot-processing, Property 5: Metadata completeness**
   * **Validates: Requirements 15.1, 15.3**
   */
  describe("CP-5: Screenshot metadata completeness", () => {
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
            const metaMatch = text.match(/## Screenshot Metadata\n(\[[\s\S]*?\])/);
            expect(metaMatch).toBeDefined();

            const metadata = JSON.parse(metaMatch![1]);
            expect(metadata[0].app_hint).toBe(appHint);
            expect(metadata[0].window_title).toBe(windowTitle);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * CP-7: Zod schema validation
   *
   * Property: VLM response parsing must:
   * - Accept valid JSON matching the schema
   * - Reject invalid JSON or schema violations
   * - Throw VLMParseError with appropriate code
   *
   * **Feature: screenshot-processing, Property 7: Schema validation**
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
   */
  describe("CP-7: Zod schema validation", () => {
    it("should accept valid VLM responses", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 4 }), // segment count (max 4)
          fc.integer({ min: 0, max: 20 }), // entity count (max 20)
          (segmentCount, entityCount) => {
            const validResponse = createValidVLMResponse({ segmentCount, entityCount });

            const processor = __test__.createProcessor();
            const result = processor.parseVLMResponse(validResponse);

            expect(result.segments.length).toBe(segmentCount);
            expect(result.entities.length).toBe(entityCount);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should reject responses with missing required fields", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 4 }), (segmentCount) => {
          // Create response with missing event.title
          const segments = Array.from({ length: segmentCount }, (_, i) => ({
            segment_id: `seg_${i}`,
            screen_ids: [i + 1],
            event: {
              // Missing title
              summary: "Test",
              confidence: 5,
              importance: 5,
            },
            derived: { knowledge: [], state: [], procedure: [], plan: [] },
            merge_hint: { decision: "NEW" },
          }));

          const invalidResponse = JSON.stringify({ segments, entities: [] });

          const processor = __test__.createProcessor();
          expect(() => processor.parseVLMResponse(invalidResponse)).toThrow(VLMParseError);
        }),
        { numRuns: 50 }
      );
    });

    it("should reject responses with invalid confidence/importance values", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 11, max: 100 }), // Invalid confidence > 10
          (invalidConfidence) => {
            const invalidResponse = JSON.stringify({
              segments: [
                {
                  segment_id: "seg_1",
                  screen_ids: [1],
                  event: {
                    title: "Test",
                    summary: "Test",
                    confidence: invalidConfidence, // Invalid: > 10
                    importance: 5,
                  },
                  derived: { knowledge: [], state: [], procedure: [], plan: [] },
                  merge_hint: { decision: "NEW" },
                },
              ],
              entities: [],
            });

            const processor = __test__.createProcessor();
            expect(() => processor.parseVLMResponse(invalidResponse)).toThrow(VLMParseError);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should handle malformed JSON gracefully", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => {
            try {
              JSON.parse(s);
              return false; // Skip valid JSON
            } catch {
              return true; // Keep invalid JSON
            }
          }),
          (malformedJson) => {
            const processor = __test__.createProcessor();

            // Should throw VLMParseError, not crash
            try {
              processor.parseVLMResponse(malformedJson);
              // If it doesn't throw, that's also acceptable if repair worked
            } catch (error) {
              expect(error).toBeInstanceOf(VLMParseError);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should enforce max limits on segments and entities", () => {
      // Test that schema enforces max 4 segments
      const tooManySegments = JSON.stringify({
        segments: Array.from({ length: 5 }, (_, i) => ({
          segment_id: `seg_${i}`,
          screen_ids: [i + 1],
          event: { title: "Test", summary: "Test", confidence: 5, importance: 5 },
          derived: { knowledge: [], state: [], procedure: [], plan: [] },
          merge_hint: { decision: "NEW" },
        })),
        entities: [],
      });

      const processor = __test__.createProcessor();
      expect(() => processor.parseVLMResponse(tooManySegments)).toThrow(VLMParseError);
    });
  });
});
