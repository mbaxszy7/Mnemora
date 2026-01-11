import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screenshotPipelineScheduler } from "./screenshot-pipeline-scheduler";
import { screenshotProcessingEventBus } from "./event-bus";
import { getDb } from "../../database";
import { batches, contextNodes, screenshots } from "../../database/schema";
import { contextGraphService } from "./context-graph-service";
import { textLLMProcessor } from "./text-llm-processor";
import { processingConfig } from "./config";
import type { ContextNodeRecord } from "../../database/schema";

// Mock dependencies
vi.mock("../../database", () => ({
  getDb: vi.fn(),
}));

vi.mock("./context-graph-service", () => ({
  contextGraphService: {
    getLinkedScreenshots: vi.fn(),
    updateNode: vi.fn(),
    linkScreenshot: vi.fn(),
  },
}));

vi.mock("./text-llm-processor", () => ({
  textLLMProcessor: {
    executeMerge: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe("ScreenshotPipelineScheduler", () => {
  const createMockDb = () => ({
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    run: vi.fn().mockReturnValue({ changes: 0 }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  });

  type MockDb = ReturnType<typeof createMockDb>;

  let mockDb: MockDb;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    screenshotProcessingEventBus.removeAllListeners();
    mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    screenshotPipelineScheduler.stop();
    screenshotProcessingEventBus.removeAllListeners();
  });

  describe("events", () => {
    it("should emit pipeline batch started/finished when batch processing fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      const started = vi.fn();
      const finished = vi.fn();
      screenshotProcessingEventBus.on("pipeline:batch:started", started);
      screenshotProcessingEventBus.on("pipeline:batch:finished", finished);

      const batchRecord = {
        id: 99,
        batchId: "batch_test",
        sourceKey: "screen:1",
        screenshotIds: JSON.stringify([1]),
        historyPack: null,
        idempotencyKey: "idem",
        status: "pending",
        attempts: 0,
        tsStart: 0,
        tsEnd: 0,
      };

      // select(batchRecord)
      mockDb.get.mockReturnValueOnce(batchRecord);

      // claim succeeds
      mockDb.run.mockReturnValue({ changes: 1 });

      const missingFileShot = {
        id: 1,
        ts: 1,
        phash: "p",
        filePath: null,
        appHint: null,
        windowTitle: null,
        width: null,
        height: null,
        bytes: null,
        mime: null,
        vlmAttempts: 0,
      };

      // 1) shotRows for main try path (missing filePath triggers failure)
      // 2) shotRows for catch path updating screenshot statuses
      mockDb.all.mockReturnValueOnce([missingFileShot]).mockReturnValueOnce([missingFileShot]);

      await (
        screenshotPipelineScheduler as unknown as {
          processBatchRecord: (record: { id: number; table: "batches" }) => Promise<void>;
        }
      ).processBatchRecord({ id: 99, table: "batches" });

      expect(started).toHaveBeenCalledTimes(1);
      expect(started).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "pipeline:batch:started",
          batchDbId: 99,
          batchId: "batch_test",
          sourceKey: "screen:1",
          attempts: 1,
          screenshotCount: 1,
        })
      );

      expect(finished).toHaveBeenCalledTimes(1);
      expect(finished).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "pipeline:batch:finished",
          batchDbId: 99,
          batchId: "batch_test",
          sourceKey: "screen:1",
          status: "failed",
          attempts: 1,
          errorMessage: expect.stringContaining("Missing filePath"),
        })
      );

      vi.useRealTimers();
    });
  });

  describe("recoverStaleStates", () => {
    it("should reset stale running states to pending", async () => {
      mockDb.run.mockReturnValueOnce({ changes: 1 }); // screenshots
      mockDb.run.mockReturnValueOnce({ changes: 1 }); // batches
      mockDb.run.mockReturnValueOnce({ changes: 2 }); // contextNodes merge

      await (
        screenshotPipelineScheduler as unknown as { recoverStaleStates: () => Promise<void> }
      ).recoverStaleStates();

      expect(mockDb.update).toHaveBeenCalledWith(screenshots);
      expect(mockDb.update).toHaveBeenCalledWith(batches);
      expect(mockDb.update).toHaveBeenCalledWith(contextNodes);
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ mergeStatus: "pending" }));

      expect(mockDb.run).toHaveBeenCalledTimes(3);
    });
  });

  describe("wake", () => {
    it("should trigger run when loop is running", () => {
      // Simulate loop is running
      (screenshotPipelineScheduler as unknown as { isRunning: boolean }).isRunning = true;

      vi.useFakeTimers();
      vi.setSystemTime(1000);

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      screenshotPipelineScheduler.wake();

      expect(setTimeoutSpy).toHaveBeenCalled();
      expect(setTimeoutSpy.mock.calls.some((c) => c[1] === 0)).toBe(true);

      // Cleanup
      (screenshotPipelineScheduler as unknown as { isRunning: boolean }).isRunning = false;
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it("should be no-op when loop is not running", () => {
      // Ensure loop is not running
      (screenshotPipelineScheduler as unknown as { isRunning: boolean }).isRunning = false;

      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      screenshotPipelineScheduler.wake();

      expect(setTimeoutSpy).not.toHaveBeenCalled();

      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe("computeEarliestNextRun", () => {
    it("should return now when there is immediate batch work", () => {
      const now = 100_000;

      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockDb.get.mockReturnValueOnce({ nextRunAt: null });

      const nextRunAt = (
        screenshotPipelineScheduler as unknown as { computeEarliestNextRun: () => number | null }
      ).computeEarliestNextRun();

      expect(nextRunAt).toBe(now);

      vi.useRealTimers();
    });

    it("should return earliest nextRunAt across tasks", () => {
      const now = 100_000;

      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockDb.get.mockReturnValueOnce({ nextRunAt: 200_000 });
      mockDb.get.mockReturnValueOnce({ nextRunAt: 150_000 });

      const nextRunAt = (
        screenshotPipelineScheduler as unknown as { computeEarliestNextRun: () => number | null }
      ).computeEarliestNextRun();

      expect(nextRunAt).toBe(150_000);

      vi.useRealTimers();
    });

    it("should consider orphan screenshot eligibility time", () => {
      const now = 100_000;

      vi.useFakeTimers();
      vi.setSystemTime(now);

      // Now queries: batches, context_nodes mergeStatus, orphan screenshots
      mockDb.get
        .mockReturnValueOnce(null) // batches
        .mockReturnValueOnce(null) // context_nodes mergeStatus
        .mockReturnValueOnce({ createdAt: 30_000 }); // orphan screenshot

      const nextRunAt = (
        screenshotPipelineScheduler as unknown as { computeEarliestNextRun: () => number | null }
      ).computeEarliestNextRun();

      expect(nextRunAt).toBe(105_000);

      vi.useRealTimers();
    });
  });

  describe("run scheduling", () => {
    it("should schedule idle scan when no work is found", async () => {
      (screenshotPipelineScheduler as unknown as { isRunning: boolean }).isRunning = true;

      vi.useFakeTimers();

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      await (
        screenshotPipelineScheduler as unknown as { runCycle: () => Promise<void> }
      ).runCycle();

      expect(
        setTimeoutSpy.mock.calls.some((c) => c[1] === processingConfig.scheduler.scanIntervalMs)
      ).toBe(true);

      setTimeoutSpy.mockRestore();

      vi.useRealTimers();
    });
  });

  describe("scanPendingRecords", () => {
    it("should scan batches, context_nodes (not screenshots or vector_documents)", async () => {
      // Note: Screenshots are no longer scanned - all screenshots are processed through batches
      // vectorDocuments are no longer scanned - now handled separately
      mockDb.all
        .mockReturnValueOnce([
          { id: 11, status: "pending", attempts: 0, nextRunAt: null },
          { id: 12, status: "failed", attempts: 1, nextRunAt: null },
        ]) // batches newest
        .mockReturnValueOnce([
          { id: 11, status: "pending", attempts: 0, nextRunAt: null },
          { id: 12, status: "failed", attempts: 1, nextRunAt: null },
        ]) // batches oldest
        .mockReturnValueOnce([{ id: 21, status: "pending", attempts: 0, nextRunAt: null }]) // context_nodes newest
        .mockReturnValueOnce([{ id: 21, status: "pending", attempts: 0, nextRunAt: null }]); // context_nodes oldest

      const records = await (
        screenshotPipelineScheduler as unknown as { scanPendingRecords: () => Promise<unknown[]> }
      ).scanPendingRecords();

      expect(records).toHaveLength(3);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 11, table: "batches", status: "pending", attempts: 0 }),
          expect.objectContaining({ id: 12, table: "batches", status: "failed", attempts: 1 }),
          expect.objectContaining({
            id: 21,
            table: "context_nodes",
            status: "pending",
            attempts: 0,
          }),
        ])
      );
    });
  });

  describe("processContextNodeMergeRecord", () => {
    it("should process pending nodes and mark them as running", async () => {
      const mockNode = {
        id: 1,
        kind: "event",
        threadId: "thread-1",
        title: "Event 1",
        summary: "Summary 1",
        mergeAttempts: 0,
      } as ContextNodeRecord;

      mockDb.get.mockReturnValueOnce(mockNode);
      mockDb.run.mockReturnValueOnce({ changes: 1 });

      // Mock handleSingleMerge to avoid deep logic in this test
      const loop = screenshotPipelineScheduler as unknown as {
        handleSingleMerge: (node: ContextNodeRecord) => Promise<void>;
      };
      const handleSingleMergeSpy = vi.spyOn(loop, "handleSingleMerge").mockResolvedValue(undefined);

      await (
        screenshotPipelineScheduler as unknown as {
          processContextNodeMergeRecord: (record: unknown) => Promise<void>;
        }
      ).processContextNodeMergeRecord({
        id: 1,
        table: "context_nodes",
        status: "pending",
        attempts: 0,
      });

      expect(mockDb.update).toHaveBeenCalledWith(contextNodes);
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ mergeStatus: "running" }));
      expect(handleSingleMergeSpy).toHaveBeenCalledWith(mockNode);
    });

    it("should handle permanent failures and backoff for retriable failures", async () => {
      const mockNode = {
        id: 1,
        kind: "event",
        mergeAttempts: processingConfig.scheduler.retryConfig.maxAttempts - 1, // Will reach max
      } as ContextNodeRecord;

      mockDb.get.mockReturnValueOnce(mockNode);
      mockDb.run.mockReturnValueOnce({ changes: 1 }).mockReturnValueOnce({ changes: 1 });
      const loop = screenshotPipelineScheduler as unknown as {
        handleSingleMerge: (node: ContextNodeRecord) => Promise<void>;
      };
      vi.spyOn(loop, "handleSingleMerge").mockRejectedValue(new Error("LLM Error"));

      await (
        screenshotPipelineScheduler as unknown as {
          processContextNodeMergeRecord: (record: unknown) => Promise<void>;
        }
      ).processContextNodeMergeRecord({
        id: 1,
        table: "context_nodes",
        status: "pending",
        attempts: processingConfig.scheduler.retryConfig.maxAttempts - 1,
      });

      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mergeStatus: "failed_permanent",
          mergeAttempts: processingConfig.scheduler.retryConfig.maxAttempts,
        })
      );
    });
  });

  describe("handleSingleMerge", () => {
    it("should mark as succeeded if no merge target is found", async () => {
      const mockNodeRecord = {
        id: 1,
        kind: "event",
        threadId: "thread-1",
        title: "Node 1",
        summary: "Summary 1",
        eventTime: 1000,
      };

      vi.mocked(contextGraphService.getLinkedScreenshots).mockReturnValue([101]);
      mockDb.get.mockReturnValue(null); // No target

      await (
        screenshotPipelineScheduler as unknown as {
          handleSingleMerge: (node: ContextNodeRecord) => Promise<void>;
        }
      ).handleSingleMerge(mockNodeRecord as ContextNodeRecord);

      expect(contextGraphService.updateNode).toHaveBeenCalledWith("1", {
        mergeStatus: "succeeded",
      });
    });

    it("should execute merge and update target node when target is found", async () => {
      const sourceRecord = {
        id: 1,
        kind: "event",
        threadId: "thread-1",
        title: "Source",
        summary: "Source Summary",
        eventTime: 2000,
        keywords: '["k1"]',
        entities: "[]",
      } as ContextNodeRecord;

      const targetRecord = {
        id: 2,
        kind: "event",
        threadId: "thread-1",
        title: "Target",
        summary: "Target Summary",
        eventTime: 1000,
        keywords: '["k2"]',
        entities: "[]",
        mergeStatus: "succeeded",
      } as ContextNodeRecord;

      mockDb.get.mockReturnValue(targetRecord);
      vi.mocked(contextGraphService.getLinkedScreenshots).mockReturnValue([101]); // For both

      const mergedNode = {
        title: "Merged Title",
        summary: "Merged Summary",
        keywords: ["k1", "k2"],
        entities: [],
        importance: 8,
        confidence: 9,
      };

      vi.mocked(textLLMProcessor.executeMerge).mockResolvedValue({
        mergedNode: mergedNode as unknown as ContextNodeRecord,
        mergedFromIds: [2, 1],
      } as unknown as Awaited<ReturnType<typeof textLLMProcessor.executeMerge>>);

      await (
        screenshotPipelineScheduler as unknown as {
          handleSingleMerge: (node: ContextNodeRecord) => Promise<void>;
        }
      ).handleSingleMerge(sourceRecord);

      // Verify target update
      expect(contextGraphService.updateNode).toHaveBeenCalledWith(
        "2",
        expect.objectContaining({
          title: "Merged Title",
          mergedFromIds: [2, 1],
        })
      );

      // Verify screenshot linking
      expect(contextGraphService.linkScreenshot).toHaveBeenCalledWith("2", "101");

      // Verify source node marked as succeeded
      expect(contextGraphService.updateNode).toHaveBeenCalledWith("1", {
        mergeStatus: "succeeded",
      });
    });
  });
});
