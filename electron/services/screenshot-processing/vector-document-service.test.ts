import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { getDb, type DrizzleDB } from "../../database";
import { vectorDocumentService } from "./vector-document-service";
import { VectorDocumentScheduler } from "./vector-document-scheduler";
import { vectorDocuments } from "../../database/schema";
import { screenshotProcessingEventBus } from "./event-bus";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";
import crypto from "node:crypto";

import type { PendingRecord } from "./types";

vi.mock("../../database", () => ({
  getDb: vi.fn(),
}));

vi.mock("./embedding-service", () => ({
  embeddingService: {
    embed: vi.fn(),
  },
}));

vi.mock("./vector-index-service", () => ({
  vectorIndexService: {
    upsert: vi.fn(),
    requestFlush: vi.fn(),
    load: vi.fn(),
    search: vi.fn(),
  },
}));

describe("VectorDocumentService", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    screenshotProcessingEventBus.removeAllListeners();
    mockDb.select.mockReset();
    mockDb.insert.mockReset();
    mockDb.update.mockReset();
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as DrizzleDB);
  });

  const mockNode = {
    id: 1,
    kind: "event",
    title: "Test Event",
    summary: "This is a test summary",
    keywords: JSON.stringify(["key1", "key2"]),
    entities: JSON.stringify([{ name: "Entity1" }]),
    threadId: "thread-123",
    eventTime: 1234567890,
  };

  describe("buildTextForNode", () => {
    it("should build text with all fields", async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      const text = await vectorDocumentService.buildTextForNode(1);

      expect(text).toContain("Title: Test Event");
      expect(text).toContain("Kind: event");
      expect(text).toContain("Summary: This is a test summary");
      expect(text).toContain("Keywords: key1, key2");
      expect(text).toContain("Entities: Entity1");
    });
  });

  describe("upsertForContextNode", () => {
    it("should create new vector document if not exists", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("vector-documents:dirty", handler);

      // 1. Initial node check
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // 2. buildTextForNode (fetches node again)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // 3. Check existing vector doc
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(null),
          }),
        }),
      });

      // 4. buildMetaForNode (fetches node again)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // Mock insert
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ id: 101 }),
          }),
        }),
      });

      const result = await vectorDocumentService.upsertForContextNode(1);

      expect(result.vectorDocumentId).toBe(101);
      expect(result.vectorId).toBe("node:1");
      expect(mockDb.insert).toHaveBeenCalled();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "vector-documents:dirty",
          reason: "upsert_for_context_node",
          vectorDocumentId: 101,
          nodeId: 1,
        })
      );
    });

    it("should not update if hash matches (idempotency)", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("vector-documents:dirty", handler);

      const text = `Title: Test Event\nKind: event\nSummary: This is a test summary\nKeywords: key1, key2\nEntities: Entity1`;
      const hash = crypto.createHash("sha256").update(text).digest("hex");

      // 1. Initial node check
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // 2. buildTextForNode
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // 3. Check existing vector doc (same hash)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ id: 101, textHash: hash }),
          }),
        }),
      });

      // 4. buildMetaForNode
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      const result = await vectorDocumentService.upsertForContextNode(1);

      expect(result.vectorDocumentId).toBe(101);
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("should update if hash differs", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("vector-documents:dirty", handler);

      // 1. Initial node check
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // 2. buildTextForNode
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // 3. Check existing vector doc (diff hash)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ id: 101, textHash: "old_hash" }),
          }),
        }),
      });

      // 4. buildMetaForNode
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(mockNode),
          }),
        }),
      });

      // Mock update
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockReturnValue({
              get: vi.fn().mockReturnValue({ id: 101 }),
            }),
          }),
        }),
      });

      await vectorDocumentService.upsertForContextNode(1);

      expect(mockDb.update).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "vector-documents:dirty",
          reason: "upsert_for_context_node",
          vectorDocumentId: 101,
          nodeId: 1,
        })
      );
    });

    it("should allow identical text across different nodes (no unique text hash)", async () => {
      const node1 = { ...mockNode, id: 1 };
      const node2 = { ...mockNode, id: 2 };

      const makeSelect = (node: typeof mockNode) => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(node),
          }),
        }),
      });

      // Upsert for node1 (4 selects)
      mockDb.select
        .mockReturnValueOnce(makeSelect(node1)) // initial node
        .mockReturnValueOnce(makeSelect(node1)) // buildTextForNode
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              get: vi.fn().mockReturnValue(null), // no existing vector doc
            }),
          }),
        })
        .mockReturnValueOnce(makeSelect(node1)); // buildMetaForNode

      // Upsert for node2 (same text/hash) (4 selects)
      mockDb.select
        .mockReturnValueOnce(makeSelect(node2)) // initial node
        .mockReturnValueOnce(makeSelect(node2)) // buildTextForNode
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              get: vi.fn().mockReturnValue(null), // no existing vector doc
            }),
          }),
        })
        .mockReturnValueOnce(makeSelect(node2)); // buildMetaForNode

      const createInsert = (id: number) => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ id }),
          }),
        }),
      });

      mockDb.insert.mockReturnValueOnce(createInsert(101)).mockReturnValueOnce(createInsert(102));

      const result1 = await vectorDocumentService.upsertForContextNode(1);
      const result2 = await vectorDocumentService.upsertForContextNode(2);

      expect(result1.vectorDocumentId).toBe(101);
      expect(result1.vectorId).toBe("node:1");
      expect(result2.vectorDocumentId).toBe(102);
      expect(result2.vectorId).toBe("node:2");
      expect(mockDb.insert).toHaveBeenCalledTimes(2);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});

// Helper type for accessing private methods in tests
type VectorDocumentSchedulerPrivate = {
  processVectorDocumentEmbeddingRecord(record: PendingRecord): Promise<void>;
  processVectorDocumentIndexRecord(record: PendingRecord): Promise<void>;
};

type SchedulerMockDB = {
  select: Mock;
  from: Mock;
  where: Mock;
  orderBy: Mock;
  limit: Mock;
  all: Mock;
  get: Mock;
  update: Mock;
  insert: Mock;
  set: Mock;
  values: Mock;
  run: Mock;
};

describe("VectorDocumentScheduler - Vector Documents", () => {
  let scheduler: VectorDocumentScheduler;
  let mockDb: SchedulerMockDB;
  const now = 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    screenshotProcessingEventBus.removeAllListeners();

    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      all: vi.fn(),
      get: vi.fn(),
      update: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      run: vi.fn().mockReturnThis(),
    };

    vi.mocked(getDb).mockReturnValue(mockDb as unknown as DrizzleDB);
    scheduler = new VectorDocumentScheduler();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("processVectorDocumentEmbeddingRecord", () => {
    it("should process pending embedding record successfully", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("vector-document:task:finished", handler);

      const mockRecord = {
        id: 1,
        table: "vector_documents" as const,
        status: "pending" as const,
        attempts: 0,
        subtask: "embedding" as const,
      };

      const mockDoc = {
        id: 1,
        refId: 100,
        embeddingStatus: "pending",
        embeddingAttempts: 0,
      };

      mockDb.get.mockReturnValue(mockDoc);
      mockDb.run.mockReturnValue({ changes: 1 }); // claim succeeds
      const buildTextSpy = vi
        .spyOn(vectorDocumentService, "buildTextForNode")
        .mockResolvedValue("mock text content");
      const mockVector = new Float32Array([0.1, 0.2, 0.3]);
      vi.mocked(embeddingService.embed).mockResolvedValue(mockVector);

      await (
        scheduler as unknown as VectorDocumentSchedulerPrivate
      ).processVectorDocumentEmbeddingRecord(mockRecord);

      expect(mockDb.update).toHaveBeenCalledWith(vectorDocuments);
      expect(mockDb.set).toHaveBeenCalledWith({
        embeddingStatus: "running",
        updatedAt: 1000,
      });

      expect(buildTextSpy).toHaveBeenCalledWith(100);
      expect(embeddingService.embed).toHaveBeenCalledWith("mock text content");

      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingStatus: "succeeded",
          indexStatus: "pending",
        })
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "vector-document:task:finished",
          subtask: "embedding",
          docId: 1,
          status: "succeeded",
        })
      );

      buildTextSpy.mockRestore();
    });

    it("should handle embedding failure", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("vector-document:task:finished", handler);

      const mockRecord = {
        id: 1,
        table: "vector_documents" as const,
        status: "pending" as const,
        attempts: 0,
        subtask: "embedding" as const,
      };

      const mockDoc = {
        id: 1,
        refId: 100,
        embeddingStatus: "pending",
        embeddingAttempts: 0,
      };

      mockDb.get.mockReturnValue(mockDoc);
      mockDb.run.mockReturnValue({ changes: 1 }); // claim succeeds
      const buildTextSpy = vi
        .spyOn(vectorDocumentService, "buildTextForNode")
        .mockResolvedValue("text");
      vi.mocked(embeddingService.embed).mockRejectedValue(new Error("API Error"));

      await (
        scheduler as unknown as VectorDocumentSchedulerPrivate
      ).processVectorDocumentEmbeddingRecord(mockRecord);

      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingStatus: "failed",
          errorMessage: "API Error",
        })
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "vector-document:task:finished",
          subtask: "embedding",
          docId: 1,
          status: "failed",
          errorMessage: "API Error",
        })
      );

      buildTextSpy.mockRestore();
    });
  });

  describe("processVectorDocumentIndexRecord", () => {
    it("should process pending index record successfully", async () => {
      const handler = vi.fn();
      screenshotProcessingEventBus.on("vector-document:task:finished", handler);

      const mockRecord = {
        id: 1,
        table: "vector_documents" as const,
        status: "pending" as const,
        attempts: 0,
        subtask: "index" as const,
      };

      const mockEmbeddingVector = new Float32Array([0.1, 0.2]);
      const mockBuffer = Buffer.from(mockEmbeddingVector.buffer);

      const mockDoc = {
        id: 1,
        embeddingStatus: "succeeded",
        embedding: mockBuffer,
        indexStatus: "pending",
        indexAttempts: 0,
      };

      mockDb.get.mockReturnValue(mockDoc);
      mockDb.run.mockReturnValue({ changes: 1 }); // claim succeeds

      await (
        scheduler as unknown as VectorDocumentSchedulerPrivate
      ).processVectorDocumentIndexRecord(mockRecord);

      expect(vectorIndexService.upsert).toHaveBeenCalledWith(1, expect.any(Float32Array));
      expect(vectorIndexService.requestFlush).toHaveBeenCalled();

      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          indexStatus: "succeeded",
        })
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "vector-document:task:finished",
          subtask: "index",
          docId: 1,
          status: "succeeded",
        })
      );
    });
  });
});
