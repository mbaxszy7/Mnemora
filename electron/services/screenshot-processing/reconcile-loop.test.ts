import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reconcileLoop } from "./reconcile-loop";
import { getDb } from "../../database";
import { batches, contextNodes, screenshots, vectorDocuments } from "../../database/schema";
import { contextGraphService } from "./context-graph-service";
import { textLLMProcessor } from "./text-llm-processor";
import { retryConfig } from "./config";
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

describe("ReconcileLoop", () => {
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
    mockDb = createMockDb();
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);
  });

  afterEach(() => {
    reconcileLoop.stop();
  });

  describe("recoverStaleStates", () => {
    it("should reset stale running states to pending", async () => {
      mockDb.run.mockReturnValueOnce({ changes: 1 }); // screenshots
      mockDb.run.mockReturnValueOnce({ changes: 1 }); // batches
      mockDb.run.mockReturnValueOnce({ changes: 2 }); // contextNodes merge
      mockDb.run.mockReturnValueOnce({ changes: 1 }); // contextNodes embedding
      mockDb.run.mockReturnValueOnce({ changes: 2 }); // vectorDocuments embedding
      mockDb.run.mockReturnValueOnce({ changes: 1 }); // vectorDocuments index

      await (
        reconcileLoop as unknown as { recoverStaleStates: () => Promise<void> }
      ).recoverStaleStates();

      expect(mockDb.update).toHaveBeenCalledWith(screenshots);
      expect(mockDb.update).toHaveBeenCalledWith(batches);
      expect(mockDb.update).toHaveBeenCalledWith(contextNodes);
      expect(mockDb.update).toHaveBeenCalledWith(vectorDocuments);
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ mergeStatus: "pending" }));

      expect(mockDb.run).toHaveBeenCalledTimes(6);
    });
  });

  describe("wake", () => {
    it("should trigger run when loop is running", () => {
      // Simulate loop is running
      (reconcileLoop as unknown as { isRunning: boolean }).isRunning = true;

      const setImmediateSpy = vi.spyOn(global, "setImmediate");

      reconcileLoop.wake();

      expect(setImmediateSpy).toHaveBeenCalled();

      // Cleanup
      (reconcileLoop as unknown as { isRunning: boolean }).isRunning = false;
      setImmediateSpy.mockRestore();
    });

    it("should be no-op when loop is not running", () => {
      // Ensure loop is not running
      (reconcileLoop as unknown as { isRunning: boolean }).isRunning = false;

      const setImmediateSpy = vi.spyOn(global, "setImmediate");

      reconcileLoop.wake();

      expect(setImmediateSpy).not.toHaveBeenCalled();

      setImmediateSpy.mockRestore();
    });
  });

  describe("computeNextRunAt", () => {
    it("should return now when there is immediate batch work", () => {
      const now = 100_000;

      mockDb.get.mockReturnValueOnce({ nextRunAt: null });

      const nextRunAt = (
        reconcileLoop as unknown as { computeNextRunAt: (now: number) => number | null }
      ).computeNextRunAt(now);

      expect(nextRunAt).toBe(now);
    });

    it("should return earliest nextRunAt across tasks", () => {
      const now = 100_000;

      mockDb.get.mockReturnValueOnce({ nextRunAt: 200_000 });
      mockDb.get.mockReturnValueOnce({ nextRunAt: 150_000 });

      const nextRunAt = (
        reconcileLoop as unknown as { computeNextRunAt: (now: number) => number | null }
      ).computeNextRunAt(now);

      expect(nextRunAt).toBe(150_000);
    });

    it("should consider orphan screenshot eligibility time", () => {
      const now = 100_000;

      mockDb.get
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ createdAt: 30_000 });

      const nextRunAt = (
        reconcileLoop as unknown as { computeNextRunAt: (now: number) => number | null }
      ).computeNextRunAt(now);

      expect(nextRunAt).toBe(105_000);
    });
  });

  describe("run scheduling", () => {
    it("should schedule idle scan when no work is found", async () => {
      (reconcileLoop as unknown as { isRunning: boolean }).isRunning = true;

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      await (reconcileLoop as unknown as { run: () => Promise<void> }).run();

      expect(setTimeoutSpy.mock.calls.some((c) => c[1] === 2 * 60 * 1000)).toBe(true);

      setTimeoutSpy.mockRestore();
    });
  });

  describe("scanPendingRecords", () => {
    it("should scan batches, context_nodes, vector_documents (not screenshots)", async () => {
      // Note: Screenshots are no longer scanned - all screenshots are processed through batches
      // Mock returns: batches, context_nodes, vector_documents (3 queries, not 4)
      mockDb.all
        .mockReturnValueOnce([
          { id: 11, status: "pending", attempts: 0, nextRunAt: null },
          { id: 12, status: "failed", attempts: 1, nextRunAt: null },
        ]) // batches
        .mockReturnValueOnce([{ id: 21, status: "pending", attempts: 0, nextRunAt: null }]) // context_nodes
        .mockReturnValueOnce([
          {
            id: 31,
            embeddingStatus: "failed",
            embeddingAttempts: 1,
            embeddingNextRunAt: null,
          },
        ]); // vector_documents (embedding)

      const records = await (
        reconcileLoop as unknown as { scanPendingRecords: () => Promise<unknown[]> }
      ).scanPendingRecords();

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
          expect.objectContaining({
            id: 31,
            table: "vector_documents",
            status: "failed",
            attempts: 1,
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
      const loop = reconcileLoop as unknown as {
        handleSingleMerge: (node: ContextNodeRecord) => Promise<void>;
      };
      const handleSingleMergeSpy = vi.spyOn(loop, "handleSingleMerge").mockResolvedValue(undefined);

      await (
        reconcileLoop as unknown as {
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
        mergeAttempts: retryConfig.maxAttempts - 1, // Will reach max
      } as ContextNodeRecord;

      mockDb.get.mockReturnValueOnce(mockNode);
      mockDb.run.mockReturnValueOnce({ changes: 1 }).mockReturnValueOnce({ changes: 1 });
      const loop = reconcileLoop as unknown as {
        handleSingleMerge: (node: ContextNodeRecord) => Promise<void>;
      };
      vi.spyOn(loop, "handleSingleMerge").mockRejectedValue(new Error("LLM Error"));

      await (
        reconcileLoop as unknown as {
          processContextNodeMergeRecord: (record: unknown) => Promise<void>;
        }
      ).processContextNodeMergeRecord({
        id: 1,
        table: "context_nodes",
        status: "pending",
        attempts: retryConfig.maxAttempts - 1,
      });

      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mergeStatus: "failed_permanent",
          mergeAttempts: retryConfig.maxAttempts,
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
        reconcileLoop as unknown as {
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
        reconcileLoop as unknown as {
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
