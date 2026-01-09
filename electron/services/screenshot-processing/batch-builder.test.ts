/**
 * Batch Builder Tests
 *
 * Tests for BatchBuilder including:
 * - Unit tests for core functionality
 * - Property tests for time order preservation and HistoryPack consistency
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";

import { BatchBuilder } from "./batch-builder";
import type { AcceptedScreenshot, Batch, SourceKey, HistoryPack } from "./types";
import { screenshotProcessingEventBus } from "./event-bus";
import { getDb } from "../../database";

vi.mock("../../database", () => ({
  getDb: vi.fn(),
}));

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Generate a valid source key
 */
function arbitrarySourceKey(): fc.Arbitrary<SourceKey> {
  return fc.oneof(
    fc.string({ minLength: 1, maxLength: 10 }).map((id) => `screen:${id}` as SourceKey),
    fc.string({ minLength: 1, maxLength: 10 }).map((id) => `window:${id}` as SourceKey)
  );
}

/**
      windowTitle: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
      width: fc.option(fc.integer({ min: 100, max: 4000 }), { nil: undefined }),
      height: fc.option(fc.integer({ min: 100, max: 4000 }), { nil: undefined }),
      bytes: fc.option(fc.integer({ min: 1000, max: 10000000 }), { nil: undefined }),
      mime: fc.option(fc.constant("image/png"), { nil: undefined }),
    }),
  });
}

/**
 * Create a mock history pack for testing
 */
function createMockHistoryPack(): HistoryPack {
  return {
    recentThreads: [
      {
        threadId: "thread_1",
        title: "Test Thread",
        lastEventSummary: "Test summary",
        lastEventTs: Date.now() - 60000,
      },
    ],
    openSegments: [],
    recentEntities: ["Entity1", "Entity2"],
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("BatchBuilder", () => {
  let builder: BatchBuilder;

  beforeEach(() => {
    screenshotProcessingEventBus.removeAllListeners();
    builder = new BatchBuilder();
  });

  it("should emit batch:persisted after persisting batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const handler = vi.fn();
    screenshotProcessingEventBus.on("batch:persisted", handler);

    const mockTx = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnValue({ id: 10 }),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      all: vi.fn().mockReturnValue([]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      run: vi.fn().mockReturnValue({ changes: 1 }),
    };

    const mockDb = {
      transaction: (fn: (tx: typeof mockTx) => number) => fn(mockTx),
    };

    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

    const sourceKey: SourceKey = "screen:1";
    const screenshots: AcceptedScreenshot[] = [
      { id: 1, ts: 1000, sourceKey, phash: "a", filePath: "/1.png", meta: {} },
    ];
    const batch = builder.createBatch(sourceKey, screenshots);
    const historyPack: HistoryPack = {
      recentThreads: [],
      openSegments: [],
      recentEntities: [],
    };

    const dbId = await (
      builder as unknown as { persistBatch: (b: Batch, h: HistoryPack) => Promise<number> }
    ).persistBatch(batch, historyPack);

    expect(dbId).toBe(10);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "batch:persisted",
        batchDbId: 10,
        batchId: batch.batchId,
        sourceKey,
        screenshotIds: [1],
      })
    );

    vi.useRealTimers();
  });

  describe("createBatch", () => {
    it("should create a batch with correct structure", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots: AcceptedScreenshot[] = [
        {
          id: 1,
          ts: 1000,
          sourceKey,
          phash: "abc123",
          filePath: "/tmp/1.png",
          meta: {},
        },
        {
          id: 2,
          ts: 2000,
          sourceKey,
          phash: "def456",
          filePath: "/tmp/2.png",
          meta: {},
        },
      ];

      const batch = builder.createBatch(sourceKey, screenshots);

      expect(batch.sourceKey).toBe(sourceKey);
      expect(batch.screenshots).toHaveLength(2);
      expect(batch.status).toBe("pending");
      expect(batch.batchId).toMatch(/^batch_\d+_[a-f0-9]+$/);
      expect(batch.idempotencyKey).toMatch(/^vlm_batch:screen:1:\d+-\d+:[a-f0-9]+$/);
      expect(batch.tsStart).toBe(1000);
      expect(batch.tsEnd).toBe(2000);
    });

    it("should throw error for empty screenshots", () => {
      const sourceKey: SourceKey = "screen:1";
      expect(() => builder.createBatch(sourceKey, [])).toThrow(
        "Cannot create batch with empty screenshots"
      );
    });

    it("should sort screenshots by timestamp", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots: AcceptedScreenshot[] = [
        { id: 1, ts: 3000, sourceKey, phash: "a", filePath: "/1.png", meta: {} },
        { id: 2, ts: 1000, sourceKey, phash: "b", filePath: "/2.png", meta: {} },
        { id: 3, ts: 2000, sourceKey, phash: "c", filePath: "/3.png", meta: {} },
      ];

      const batch = builder.createBatch(sourceKey, screenshots);

      expect(batch.screenshots[0].ts).toBe(1000);
      expect(batch.screenshots[1].ts).toBe(2000);
      expect(batch.screenshots[2].ts).toBe(3000);
    });

    it("should generate stable idempotency key for same input", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots: AcceptedScreenshot[] = [
        { id: 1, ts: 1000, sourceKey, phash: "a", filePath: "/1.png", meta: {} },
        { id: 2, ts: 2000, sourceKey, phash: "b", filePath: "/2.png", meta: {} },
      ];

      const batch1 = builder.createBatch(sourceKey, screenshots);
      const batch2 = builder.createBatch(sourceKey, screenshots);

      // Idempotency key should be the same for same screenshots
      expect(batch1.idempotencyKey).toBe(batch2.idempotencyKey);
    });
  });

  describe("splitIntoShards", () => {
    it("should split batch into correct number of shards", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots: AcceptedScreenshot[] = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        ts: 1000 + i * 100,
        sourceKey,
        phash: `hash${i}`,
        filePath: `/tmp/${i}.png`,
        meta: {},
      }));

      const batch = builder.createBatch(sourceKey, screenshots);
      const historyPack = createMockHistoryPack();
      batch.historyPack = historyPack;
      const shards = builder.splitIntoShards(batch, 5);

      expect(shards).toHaveLength(2);
      expect(shards[0].screenshots).toHaveLength(5);
      expect(shards[1].screenshots).toHaveLength(5);
    });

    it("should handle batch smaller than shard size", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots: AcceptedScreenshot[] = [
        { id: 1, ts: 1000, sourceKey, phash: "a", filePath: "/1.png", meta: {} },
        { id: 2, ts: 2000, sourceKey, phash: "b", filePath: "/2.png", meta: {} },
      ];

      const batch = builder.createBatch(sourceKey, screenshots);
      const historyPack = createMockHistoryPack();
      batch.historyPack = historyPack;
      const shards = builder.splitIntoShards(batch, 5);

      expect(shards).toHaveLength(1);
      expect(shards[0].screenshots).toHaveLength(2);
    });

    it("should assign correct shard indices", () => {
      const sourceKey: SourceKey = "screen:1";
      const screenshots: AcceptedScreenshot[] = Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        ts: 1000 + i * 100,
        sourceKey,
        phash: `hash${i}`,
        filePath: `/tmp/${i}.png`,
        meta: {},
      }));

      const batch = builder.createBatch(sourceKey, screenshots);
      const historyPack = createMockHistoryPack();
      batch.historyPack = historyPack;
      const shards = builder.splitIntoShards(batch, 5);

      expect(shards).toHaveLength(3);
      expect(shards[0].shardIndex).toBe(0);
      expect(shards[1].shardIndex).toBe(1);
      expect(shards[2].shardIndex).toBe(2);
    });
  });

  describe("buildHistoryPack", () => {
    // Skip this test as it requires Electron environment (getDb() calls app.getPath())
    // The actual database queries are tested in integration tests
    it.skip("should return empty arrays when database is empty or unavailable", () => {
      const sourceKey: SourceKey = "screen:1";
      const testBuilder = new BatchBuilder();
      const historyPack = testBuilder.buildHistoryPack(sourceKey);

      expect(historyPack).toHaveProperty("recentThreads");
      expect(historyPack).toHaveProperty("openSegments");
      expect(historyPack).toHaveProperty("recentEntities");
      expect(Array.isArray(historyPack.recentThreads)).toBe(true);
      expect(Array.isArray(historyPack.openSegments)).toBe(true);
      expect(Array.isArray(historyPack.recentEntities)).toBe(true);
    });
  });
});

// ============================================================================
// Property Tests
// ============================================================================

describe("BatchBuilder Property Tests", () => {
  /**
   *
   */
  describe("Shard splitting preserves time order", () => {
    it("should maintain chronological order within each shard", () => {
      fc.assert(
        fc.property(
          arbitrarySourceKey(),
          fc.integer({ min: 2, max: 20 }),
          fc.integer({ min: 1, max: 10 }),
          (sourceKey, screenshotCount, shardSize) => {
            // Generate screenshots with random timestamps
            const screenshots: AcceptedScreenshot[] = Array.from(
              { length: screenshotCount },
              (_, i) => ({
                id: i + 1,
                ts: Math.floor(Math.random() * 1000000) + 1000000000000,
                sourceKey,
                phash: `hash${i}`,
                filePath: `/tmp/${i}.png`,
                meta: {},
              })
            );

            const builder = new BatchBuilder();
            const batch = builder.createBatch(sourceKey, screenshots);
            const historyPack = createMockHistoryPack();
            batch.historyPack = historyPack;
            const shards = builder.splitIntoShards(batch, shardSize);

            // Verify each shard maintains internal time order
            for (const shard of shards) {
              for (let i = 0; i < shard.screenshots.length - 1; i++) {
                expect(shard.screenshots[i].ts).toBeLessThanOrEqual(shard.screenshots[i + 1].ts);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should maintain chronological order across shards", () => {
      fc.assert(
        fc.property(
          arbitrarySourceKey(),
          fc.integer({ min: 2, max: 20 }),
          fc.integer({ min: 1, max: 10 }),
          (sourceKey, screenshotCount, shardSize) => {
            // Generate screenshots with random timestamps
            const screenshots: AcceptedScreenshot[] = Array.from(
              { length: screenshotCount },
              (_, i) => ({
                id: i + 1,
                ts: Math.floor(Math.random() * 1000000) + 1000000000000,
                sourceKey,
                phash: `hash${i}`,
                filePath: `/tmp/${i}.png`,
                meta: {},
              })
            );

            const builder = new BatchBuilder();
            const batch = builder.createBatch(sourceKey, screenshots);
            const historyPack = createMockHistoryPack();
            batch.historyPack = historyPack;
            const shards = builder.splitIntoShards(batch, shardSize);

            // Verify time order across shards
            for (let i = 0; i < shards.length - 1; i++) {
              const lastOfCurrent = shards[i].screenshots[shards[i].screenshots.length - 1];
              const firstOfNext = shards[i + 1].screenshots[0];
              expect(lastOfCurrent.ts).toBeLessThanOrEqual(firstOfNext.ts);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should preserve all screenshots after splitting", () => {
      fc.assert(
        fc.property(
          arbitrarySourceKey(),
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 10 }),
          (sourceKey, screenshotCount, shardSize) => {
            const screenshots: AcceptedScreenshot[] = Array.from(
              { length: screenshotCount },
              (_, i) => ({
                id: i + 1,
                ts: 1000000000000 + i * 1000,
                sourceKey,
                phash: `hash${i}`,
                filePath: `/tmp/${i}.png`,
                meta: {},
              })
            );

            const builder = new BatchBuilder();
            const batch = builder.createBatch(sourceKey, screenshots);
            const historyPack = createMockHistoryPack();
            batch.historyPack = historyPack;
            const shards = builder.splitIntoShards(batch, shardSize);

            // Count total screenshots across all shards
            const totalInShards = shards.reduce((sum, shard) => sum + shard.screenshots.length, 0);
            expect(totalInShards).toBe(screenshotCount);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   *
   */
  describe("HistoryPack consistency across shards", () => {
    it("should share the same HistoryPack across all shards", () => {
      fc.assert(
        fc.property(
          arbitrarySourceKey(),
          fc.integer({ min: 2, max: 20 }),
          fc.integer({ min: 1, max: 5 }),
          (sourceKey, screenshotCount, shardSize) => {
            const screenshots: AcceptedScreenshot[] = Array.from(
              { length: screenshotCount },
              (_, i) => ({
                id: i + 1,
                ts: 1000000000000 + i * 1000,
                sourceKey,
                phash: `hash${i}`,
                filePath: `/tmp/${i}.png`,
                meta: {},
              })
            );

            const builder = new BatchBuilder();
            const batch = builder.createBatch(sourceKey, screenshots);
            const historyPack = createMockHistoryPack();
            batch.historyPack = historyPack;
            const shards = builder.splitIntoShards(batch, shardSize);

            // All shards should have the same historyPack reference
            for (const shard of shards) {
              expect(shard.historyPack).toBe(historyPack);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should have identical HistoryPack content across all shards", () => {
      fc.assert(
        fc.property(
          arbitrarySourceKey(),
          fc.integer({ min: 2, max: 20 }),
          fc.integer({ min: 1, max: 5 }),
          fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
          (sourceKey, screenshotCount, shardSize, entities) => {
            const screenshots: AcceptedScreenshot[] = Array.from(
              { length: screenshotCount },
              (_, i) => ({
                id: i + 1,
                ts: 1000000000000 + i * 1000,
                sourceKey,
                phash: `hash${i}`,
                filePath: `/tmp/${i}.png`,
                meta: {},
              })
            );

            const historyPack: HistoryPack = {
              recentThreads: [
                {
                  threadId: "thread_test",
                  title: "Test Thread",
                  lastEventSummary: "Summary",
                  lastEventTs: Date.now(),
                },
              ],
              openSegments: [],
              recentEntities: entities,
            };

            const builder = new BatchBuilder();
            const batch = builder.createBatch(sourceKey, screenshots);
            batch.historyPack = historyPack;
            const shards = builder.splitIntoShards(batch, shardSize);

            // Verify all shards have identical historyPack content
            for (const shard of shards) {
              expect(shard.historyPack.recentThreads).toEqual(historyPack.recentThreads);
              expect(shard.historyPack.openSegments).toEqual(historyPack.openSegments);
              expect(shard.historyPack.recentEntities).toEqual(historyPack.recentEntities);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Additional property: Idempotency key stability
   *
   * Property: Same screenshots should produce the same idempotency key
   */
  describe("Idempotency key stability", () => {
    it("should generate stable idempotency key for same screenshots", () => {
      fc.assert(
        fc.property(arbitrarySourceKey(), fc.integer({ min: 1, max: 10 }), (sourceKey, count) => {
          const screenshots: AcceptedScreenshot[] = Array.from({ length: count }, (_, i) => ({
            id: i + 1,
            ts: 1000000000000 + i * 1000,
            sourceKey,
            phash: `hash${i}`,
            filePath: `/tmp/${i}.png`,
            meta: {},
          }));

          const builder = new BatchBuilder();
          const batch1 = builder.createBatch(sourceKey, screenshots);
          const batch2 = builder.createBatch(sourceKey, screenshots);

          expect(batch1.idempotencyKey).toBe(batch2.idempotencyKey);
        }),
        { numRuns: 100 }
      );
    });

    it("should generate different idempotency key for different screenshots", () => {
      fc.assert(
        fc.property(arbitrarySourceKey(), (sourceKey) => {
          const screenshots1: AcceptedScreenshot[] = [
            { id: 1, ts: 1000, sourceKey, phash: "a", filePath: "/1.png", meta: {} },
          ];
          const screenshots2: AcceptedScreenshot[] = [
            { id: 2, ts: 1000, sourceKey, phash: "b", filePath: "/2.png", meta: {} },
          ];

          const builder = new BatchBuilder();
          const batch1 = builder.createBatch(sourceKey, screenshots1);
          const batch2 = builder.createBatch(sourceKey, screenshots2);

          expect(batch1.idempotencyKey).not.toBe(batch2.idempotencyKey);
        }),
        { numRuns: 100 }
      );
    });
  });
});
