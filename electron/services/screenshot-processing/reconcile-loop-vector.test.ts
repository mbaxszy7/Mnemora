import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { ReconcileLoop } from "./reconcile-loop";
import { getDb } from "../../database";
import { vectorDocuments } from "../../database/schema";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";
import { vectorDocumentService } from "./vector-document-service";

import type { DrizzleDB } from "../../database";
import type { PendingRecord } from "./types";

// Helper type for accessing private methods in tests
type ReconcileLoopPrivate = {
  processVectorDocumentEmbeddingRecord(record: PendingRecord): Promise<void>;
  processVectorDocumentIndexRecord(record: PendingRecord): Promise<void>;
};

type MockDB = {
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

// Mock dependencies
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
    flush: vi.fn(),
    load: vi.fn(),
    search: vi.fn(),
  },
}));

vi.mock("./vector-document-service", () => ({
  vectorDocumentService: {
    buildTextForNode: vi.fn(),
    upsertForContextNode: vi.fn(),
  },
}));

vi.mock("./text-llm-processor", () => ({
  expandVLMIndexToNodes: vi.fn(),
  textLLMProcessor: {
    executeMerge: vi.fn<(...args: unknown[]) => unknown>(),
  },
}));

describe("ReconcileLoop - Vector Documents", () => {
  let reconcileLoop: ReconcileLoop;
  let mockDb: MockDB;
  const now = 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

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
    reconcileLoop = new ReconcileLoop();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("processVectorDocumentEmbeddingRecord", () => {
    it("should process pending embedding record successfully", async () => {
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

      // Setup mocks
      mockDb.all.mockReturnValueOnce([]); // batches
      mockDb.all.mockReturnValueOnce([]); // merges
      // We manually call processRecord in this test, so scan isn't strictly needed if we test processRecord directly,
      // but if we test run(), scan will be called. Let's test processRecord directly via casting to any.

      mockDb.get.mockReturnValue(mockDoc);
      vi.mocked(vectorDocumentService.buildTextForNode).mockResolvedValue("mock text content");
      const mockVector = new Float32Array([0.1, 0.2, 0.3]);
      vi.mocked(embeddingService.embed).mockResolvedValue(mockVector);

      // Execute private method via cast
      await (reconcileLoop as unknown as ReconcileLoopPrivate).processVectorDocumentEmbeddingRecord(
        mockRecord
      );

      // Verify Flow:
      // 1. Mark running
      expect(mockDb.update).toHaveBeenCalledWith(vectorDocuments);
      expect(mockDb.set).toHaveBeenCalledWith({
        embeddingStatus: "running",
        updatedAt: 1000,
      });

      // 2. Build text
      expect(vectorDocumentService.buildTextForNode).toHaveBeenCalledWith(100);

      // 3. Generate embedding
      expect(embeddingService.embed).toHaveBeenCalledWith("mock text content");

      // 4. Save success
      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingStatus: "succeeded",
          indexStatus: "pending",
        })
      );
    });

    it("should handle embedding failure", async () => {
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
      vi.mocked(vectorDocumentService.buildTextForNode).mockResolvedValue("text");
      vi.mocked(embeddingService.embed).mockRejectedValue(new Error("API Error"));

      await (reconcileLoop as unknown as ReconcileLoopPrivate).processVectorDocumentEmbeddingRecord(
        mockRecord
      );

      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          embeddingStatus: "failed",
          errorMessage: "API Error",
        })
      ); // Note: Using shared/legacy or specific fields? Implementation used shared errorMessage/errorCode?
      // Wait, I updated it to use GENERIC ones? No, I updated to use SPECIFIC ones but noticed schema only has generic.
      // Ah, in Step 111 I updated to use errorMessage/errorCode instead of embeddingErrorMessage etc.
      // So I should expect errorMessage.
    });
  });

  describe("processVectorDocumentIndexRecord", () => {
    it("should process pending index record successfully", async () => {
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

      await (reconcileLoop as unknown as ReconcileLoopPrivate).processVectorDocumentIndexRecord(
        mockRecord
      );

      // Verify:
      // 1. Mark running
      // 2. Upsert
      expect(vectorIndexService.upsert).toHaveBeenCalledWith(1, expect.any(Float32Array));
      expect(vectorIndexService.flush).toHaveBeenCalled();

      // 3. Mark succeeded
      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          indexStatus: "succeeded",
        })
      );
    });
  });
});
