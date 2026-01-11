/**
 * Source Buffer Registry Tests
 *
 * Tests for the SourceBufferRegistry class.
 * Covers:
 * - add() with pHash deduplication
 * - get() buffer access
 * - refresh() source management
 * - CP-3: Batch trigger conditions (count or timeout)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import crypto from "node:crypto";

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

import { SourceBufferRegistry, type ScreenshotInput } from "./source-buffer-registry";
import { screenshotProcessingEventBus } from "./event-bus";
import { processingConfig } from "./config";
import type { AcceptedScreenshot, SourceKey } from "./types";
import type { CapturePreferences } from "@shared/capture-source-types";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock CapturePreferences
 */
function createMockPreferences(
  screenDisplayIds: string[] = ["1"],
  appIds: string[] = []
): CapturePreferences {
  return {
    selectedScreens: screenDisplayIds.map((displayId, index) => ({
      id: displayId,
      name: `Screen ${displayId}`,
      type: "screen" as const,
      displayId,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isPrimary: index === 0,
      thumbnail: "",
    })),
    selectedApps: appIds.map((id) => ({
      id,
      name: `App ${id}`,
      type: "window" as const,
      appIcon: "",
      appName: `App ${id}`,
    })),
  };
}

/**
 * Create a mock PHashDedup that doesn't compute actual hashes
 */
function createMockPHashDedup(): { computeHash: (imageBuffer: Buffer) => Promise<string> } {
  return {
    computeHash: vi.fn().mockImplementation(async () => {
      return generateTestPhash(`${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    }),
  };
}

/**
 * Generate a valid 16-char hex pHash for testing
 */
function generateTestPhash(seed: string | number): string {
  return crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 16);
}

/**
 * Create a mock ScreenshotInput for testing
 */
function createMockInput(
  id: number,
  sourceKey: SourceKey = "screen:1",
  ts?: number,
  phash?: string
): ScreenshotInput {
  return {
    sourceKey,
    imageBuffer: Buffer.from(`fake_image_${id}`),
    phash: phash ?? generateTestPhash(id),
    screenshot: {
      ts: ts ?? Date.now(),
      sourceKey,
      filePath: `/path/to/screenshot_${id}.png`,
      meta: {
        appHint: "TestApp",
        windowTitle: "Test Window",
        width: 1920,
        height: 1080,
        bytes: 1024,
        mime: "image/png",
      },
    },
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("SourceBufferRegistry", () => {
  class TestSourceBufferRegistry extends SourceBufferRegistry {
    init(
      onPersistAcceptedScreenshot: (screenshot: Omit<AcceptedScreenshot, "id">) => Promise<number>
    ): void {
      this.initialize(onPersistAcceptedScreenshot);
    }

    shutdown(): void {
      this.dispose();
    }
  }

  let registry: TestSourceBufferRegistry;
  let mockPreferences: CapturePreferences;
  let mockPHashDedup: ReturnType<typeof createMockPHashDedup>;

  // Store original config values
  const originalBatchSize = processingConfig.batch.batchSize;
  const originalBatchTimeoutMs = processingConfig.batch.batchTimeoutMs;
  const originalGracePeriodMs = processingConfig.captureSource.gracePeriodMs;

  beforeEach(async () => {
    vi.useFakeTimers();
    screenshotProcessingEventBus.removeAllListeners();
    // Override config for testing
    (processingConfig.batch as { batchSize: number }).batchSize = 10;
    (processingConfig.batch as { batchTimeoutMs: number }).batchTimeoutMs = 60000;
    (processingConfig.captureSource as { gracePeriodMs: number }).gracePeriodMs = 60000;

    mockPHashDedup = createMockPHashDedup();
    mockPreferences = createMockPreferences(["1", "2"], ["app1"]);
    registry = new TestSourceBufferRegistry(mockPHashDedup.computeHash);
    let nextDbId = 0;
    registry.init(
      vi.fn(async () => {
        nextDbId += 1;
        return nextDbId;
      })
    );
    registry.setPreferences(mockPreferences);
    await registry.refresh();
  });

  afterEach(() => {
    registry.shutdown();
    screenshotProcessingEventBus.removeAllListeners();
    vi.useRealTimers();
    // Restore original config
    (processingConfig.batch as { batchSize: number }).batchSize = originalBatchSize;
    (processingConfig.batch as { batchTimeoutMs: number }).batchTimeoutMs = originalBatchTimeoutMs;
    (processingConfig.captureSource as { gracePeriodMs: number }).gracePeriodMs =
      originalGracePeriodMs;
  });

  describe("initialization", () => {
    it("should create buffers for active sources after refresh", async () => {
      await registry.refresh();

      expect(registry.get("screen:1")).toBeDefined();
      expect(registry.get("screen:2")).toBeDefined();
      expect(registry.get("window:app1")).toBeDefined();
    });
  });

  describe("add", () => {
    it("should accept screenshot for active source", async () => {
      const input = createMockInput(1, "screen:1");
      const result = await registry.add(input);

      expect(result.accepted).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should emit screenshot-accept for accepted screenshot", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("screenshot-accept", handler);

      const input = createMockInput(1, "screen:1");
      const result = await registry.add(input);

      expect(result.accepted).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.any(Number),
          sourceKey: "screen:1",
          filePath: "/path/to/screenshot_1.png",
        })
      );
    });

    it("should reject screenshot for inactive source", async () => {
      const input = createMockInput(1, "screen:999");
      const result = await registry.add(input);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("source_inactive");
    });

    it("should reject duplicate screenshot (same pHash)", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("screenshot-accept", handler);

      const same = generateTestPhash("same_hash");
      const input1 = createMockInput(1, "screen:1", Date.now(), same);
      const input2 = createMockInput(2, "screen:1", Date.now(), same);

      await registry.add(input1);
      const result = await registry.add(input2);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("duplicate");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should accept screenshots with different pHash", async () => {
      const input1 = createMockInput(1, "screen:1", Date.now(), generateTestPhash("hash_a"));
      const input2 = createMockInput(2, "screen:1", Date.now(), generateTestPhash("hash_b"));

      const result1 = await registry.add(input1);
      const result2 = await registry.add(input2);

      expect(result1.accepted).toBe(true);
      expect(result2.accepted).toBe(true);
    });

    it("should not mix screenshots from different sources", async () => {
      const input1 = createMockInput(1, "screen:1");
      const input2 = createMockInput(2, "screen:2");

      await registry.add(input1);
      await registry.add(input2);

      expect(registry.get("screen:1")?.screenshots).toHaveLength(1);
      expect(registry.get("screen:2")?.screenshots).toHaveLength(1);
    });

    it("should update lastSeenAt when adding", async () => {
      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));
      const input = createMockInput(1, "screen:1");

      await registry.add(input);

      const buffer = registry.get("screen:1");
      expect(buffer?.lastSeenAt).toBe(new Date("2024-01-01T10:00:00Z").getTime());
    });

    it("should set batchStartTs on first screenshot", async () => {
      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));
      const input = createMockInput(1, "screen:1");

      await registry.add(input);

      const buffer = registry.get("screen:1");
      expect(buffer?.batchStartTs).toBe(new Date("2024-01-01T10:00:00Z").getTime());
    });
  });

  describe("shouldTriggerBatch - CP-3: Batch trigger conditions", () => {
    it("should drain buffer when batchSize is reached", async () => {
      const sourceKey: SourceKey = "screen:1";

      const batchHandler = vi.fn();
      screenshotProcessingEventBus.on("batch:ready", batchHandler);

      // Add 9 screenshots - should not trigger drain
      for (let i = 0; i < 9; i++) {
        const result = await registry.add(
          createMockInput(i, sourceKey, Date.now(), generateTestPhash(`b_${i}`))
        );
        expect(result.accepted).toBe(true);
      }

      expect(registry.get(sourceKey)?.screenshots).toHaveLength(9);

      // 10th screenshot should trigger drain
      await registry.add(createMockInput(9, sourceKey, Date.now(), generateTestPhash("b_9")));

      expect(registry.get(sourceKey)?.screenshots).toHaveLength(0);
      expect(batchHandler).toHaveBeenCalledTimes(1);
      expect(batchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "batch:ready",
          trigger: "add",
          batches: expect.objectContaining({
            [sourceKey]: expect.any(Array),
          }),
        })
      );
      const firstEvent = batchHandler.mock.calls[0]?.[0] as {
        batches: Record<string, unknown[]>;
      };
      expect(firstEvent.batches[sourceKey]).toHaveLength(10);
    });

    it("should not drain buffer before timeout when count is below threshold", async () => {
      const sourceKey: SourceKey = "screen:1";

      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));
      await registry.add(createMockInput(1, sourceKey));

      // Advance time by 59 seconds (just before 60s timeout)
      vi.advanceTimersByTime(59000);

      const result = await registry.add(
        createMockInput(2, sourceKey, Date.now(), generateTestPhash("timeout_2"))
      );
      expect(result.accepted).toBe(true);
      expect(registry.get(sourceKey)?.screenshots).toHaveLength(2);
    });

    it("should drain buffer when timeout (60s) is reached", async () => {
      const sourceKey: SourceKey = "screen:1";

      const batchHandler = vi.fn();
      screenshotProcessingEventBus.on("batch:ready", batchHandler);

      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));
      await registry.add(createMockInput(1, sourceKey));

      // Advance time by exactly 60 seconds
      vi.advanceTimersByTime(60000);

      // Run the AutoRefreshCache tick that processes timeout-triggered batches
      await vi.runOnlyPendingTimersAsync();

      expect(registry.get(sourceKey)?.screenshots).toHaveLength(0);
      expect(batchHandler).toHaveBeenCalledTimes(1);
      expect(batchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "batch:ready",
          trigger: "timeout",
        })
      );

      await registry.add(
        createMockInput(2, sourceKey, Date.now(), generateTestPhash("timeout_after"))
      );

      expect(registry.get(sourceKey)?.screenshots).toHaveLength(1);
    });

    it("should handle multiple sources independently", async () => {
      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));

      // Source 1: trigger by count
      for (let i = 0; i < 10; i++) {
        await registry.add(
          createMockInput(i, "screen:1", Date.now(), generateTestPhash(`s1_${i}`))
        );
      }

      const s2Before = await registry.add(
        createMockInput(100, "screen:2", Date.now(), generateTestPhash("s2_before"))
      );
      expect(s2Before.accepted).toBe(true);
      expect(registry.get("screen:2")?.screenshots).toHaveLength(1);

      // Advance time to trigger timeout for source 2
      vi.advanceTimersByTime(60000);

      // Run the AutoRefreshCache tick that processes timeout-triggered batches
      await vi.runOnlyPendingTimersAsync();

      expect(registry.get("screen:2")?.screenshots).toHaveLength(0);

      await registry.add(
        createMockInput(101, "screen:2", Date.now(), generateTestPhash("s2_after"))
      );

      expect(registry.get("screen:2")?.screenshots).toHaveLength(1);
    });
  });

  describe("refresh and grace period", () => {
    it("should remove inactive sources after grace period", async () => {
      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));

      // Add screenshots to both sources
      await registry.add(createMockInput(1, "screen:1", Date.now(), generateTestPhash("grace_1")));
      await registry.add(createMockInput(2, "screen:2", Date.now(), generateTestPhash("grace_2")));

      // Update preferences to only include screen:1
      registry.setPreferences(createMockPreferences(["1"], []));

      // Advance time past grace period (60s) and trigger refresh
      vi.advanceTimersByTime(70000);
      await registry.refresh();

      // screen:2 should be removed after grace period
      expect(registry.get("screen:2")).toBeUndefined();
      // screen:1 should remain
      expect(registry.get("screen:1")).toBeDefined();
    });

    it("should not remove sources within grace period", async () => {
      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));

      await registry.add(createMockInput(1, "screen:1", Date.now(), generateTestPhash("grace_1")));
      await registry.add(createMockInput(2, "screen:2", Date.now(), generateTestPhash("grace_2")));

      // Update preferences to only include screen:1
      registry.setPreferences(createMockPreferences(["1"], []));

      // Advance time but stay within grace period (30s < 60s)
      vi.advanceTimersByTime(30000);
      await registry.refresh();

      // Both should still exist (within grace period)
      expect(registry.get("screen:1")).toBeDefined();
      expect(registry.get("screen:2")).toBeDefined();
    });
  });

  describe("get", () => {
    it("should return undefined for non-existent buffer", () => {
      expect(registry.get("screen:nonexistent")).toBeUndefined();
    });

    it("should return buffer for existing source", async () => {
      await registry.add(createMockInput(1, "screen:1"));
      const buffer = registry.get("screen:1");

      expect(buffer).toBeDefined();
      expect(buffer?.sourceKey).toBe("screen:1");
      expect(buffer?.screenshots).toHaveLength(1);
    });
  });
});
