import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDb, type DrizzleDB } from "../../database";
import { vectorDocumentService } from "./vector-document-service";
import crypto from "node:crypto";

vi.mock("../../database", () => ({
  getDb: vi.fn(),
}));

describe("VectorDocumentService", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    });

    it("should not update if hash matches (idempotency)", async () => {
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
    });

    it("should update if hash differs", async () => {
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
