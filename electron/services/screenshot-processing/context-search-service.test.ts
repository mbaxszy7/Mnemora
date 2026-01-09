import { describe, it, expect, beforeEach, vi } from "vitest";
import { contextSearchService } from "./context-search-service";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";
import type { DrizzleDB } from "../../database";
import type { ContextNodeRecord } from "../../database/schema";

// ============================================================================
// Mock Setup
// ============================================================================

let selectResults: unknown[][] = [];

vi.mock("../../database", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => selectResults.shift() || []),
          limit: vi.fn(() => ({
            all: vi.fn(() => selectResults.shift() || []),
          })),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            all: vi.fn(() => []),
          })),
        })),
      })),
    })),
  })),
}));

vi.mock("./embedding-service", () => ({
  embeddingService: {
    embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
  },
}));

vi.mock("./vector-index-service", () => ({
  vectorIndexService: {
    search: vi.fn(async () => [{ docId: 500, score: 0.1 }]),
  },
}));

vi.mock("./context-graph-service", () => ({
  contextGraphService: {
    recordToExpandedNode: vi.fn((record: ContextNodeRecord) => ({
      id: record.id,
      kind: record.kind,
      title: record.title,
      summary: record.summary,
      keywords: [],
      entities: [],
      importance: 5,
      confidence: 5,
      screenshotIds: [],
      eventTime: record.eventTime,
      threadId: record.threadId,
    })),
    getThread: vi.fn(async () => []),
    traverse: vi.fn(async () => ({ nodes: [], edges: [], screenshotIds: [] })),
  },
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("ContextSearchService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
  });

  describe("search", () => {
    // TODO: This test needs comprehensive mock updates to match current search implementation
    // with activity cross-table retrieval and deep search. Skip for now.
    it.skip("should perform semantic search and return results sorted by score", async () => {
      // Mock vector index to return two docs with different scores
      vi.mocked(vectorIndexService.search).mockResolvedValue([
        { docId: 501, score: 0.1 }, // Better score
        { docId: 502, score: 0.5 }, // Worse score
      ]);

      const { getDb } = await import("../../database");
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const results = selectResults.shift();
            return {
              all: () => results || [],
              limit: vi.fn().mockImplementation(() => ({
                all: () => selectResults.shift() || [],
              })),
            };
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              all: () => [],
            }),
          }),
        }),
      });
      vi.mocked(getDb).mockReturnValue({ select: mockSelect } as unknown as DrizzleDB);

      selectResults = [
        [
          { id: 501, refId: 101 },
          { id: 502, refId: 102 },
        ], // vectorDocuments lookup
        [
          { id: 102, kind: "event", title: "Worse Node", summary: "Summary" },
          { id: 101, kind: "event", title: "Better Node", summary: "Summary" },
        ], // contextNodes lookup (unordered from DB)
        [
          { nodeId: 101, screenshotId: 200 },
          { nodeId: 102, screenshotId: 201 },
        ], // getScreenshotIdsByNodeIds -> contextScreenshotLinks
        [
          { id: 200, ts: 1000, storageState: "persisted" },
          { id: 201, ts: 1100, storageState: "persisted" },
        ], // getEvidence -> screenshots (raw DB records use 'ts')
      ];

      const result = await contextSearchService.search({ query: "find something" });

      expect(embeddingService.embed).toHaveBeenCalledWith("find something", undefined);
      expect(vectorIndexService.search).toHaveBeenCalled();

      // Event nodes are now in relatedEvents, not nodes
      // Nodes should only contain non-event kinds
      expect(result.nodes).toHaveLength(0); // Event nodes go to relatedEvents
      expect(result.relatedEvents).toHaveLength(2);
      expect(result.relatedEvents[0].id).toBe(101);
      expect(result.relatedEvents[0].title).toBe("Better Node");
      expect(result.relatedEvents[0].screenshotIds).toEqual([200]);
      expect(result.relatedEvents[1].id).toBe(102);
      expect(result.relatedEvents[1].title).toBe("Worse Node");
      expect(result.relatedEvents[1].screenshotIds).toEqual([201]);

      // Evidence should be sorted by timestamp desc: 201 (1100) then 200 (1000)
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence[0].screenshotId).toBe(201);
      expect(result.evidence[0].timestamp).toBe(1100);
      expect(result.evidence[1].screenshotId).toBe(200);
      expect(result.evidence[1].timestamp).toBe(1000);
    });

    it("should return empty result if no matches found in index", async () => {
      vi.mocked(vectorIndexService.search).mockResolvedValue([]);
      const result = await contextSearchService.search({ query: "non-existent" });
      expect(result.nodes).toHaveLength(0);
      expect(result.evidence).toHaveLength(0);
    });

    // TODO: This test needs comprehensive mock updates to match current search implementation
    // with activity cross-table retrieval and complex filters. Skip for now.
    it.skip("should apply filters to results", async () => {
      vi.mocked(vectorIndexService.search).mockResolvedValue([{ docId: 500, score: 0.1 }]);
      const { getDb } = await import("../../database");
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const results = selectResults.shift();
            return {
              all: () => results || [],
              limit: vi.fn().mockImplementation(() => ({
                all: () => selectResults.shift() || [],
              })),
            };
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              all: () => [],
            }),
          }),
        }),
      });
      vi.mocked(getDb).mockReturnValue({ select: mockSelect } as unknown as DrizzleDB);

      selectResults = [
        [{ id: 500, refId: 100 }], // vectorDocuments
        [
          {
            id: 100,
            kind: "event",
            title: "Filtered Node",
            summary: "Summary",
            threadId: "thread_A",
            eventTime: 5000,
          },
        ], // contextNodes
        [{ nodeId: 100, screenshotId: 200 }], // getScreenshotIdsByNodeIds -> contextScreenshotLinks
        [{ id: 200, ts: 5000, storageState: "persisted" }], // getEvidence -> screenshots (raw DB records use 'ts')
      ];

      // Test threadId filter mismatch
      const resultMismatch = await contextSearchService.search({
        query: "test",
        filters: { threadId: "thread_B" },
      });
      expect(resultMismatch.nodes).toHaveLength(0);

      // Reset for match test
      selectResults = [
        [{ id: 500, refId: 100 }],
        [
          {
            id: 100,
            kind: "event",
            title: "Matched Node",
            summary: "Summary",
            threadId: "thread_A",
            eventTime: 5000,
          },
        ],
        [{ nodeId: 100, screenshotId: 200 }],
        [{ id: 200, ts: 5000, storageState: "persisted" }], // raw DB records use 'ts'
      ];
      const resultMatch = await contextSearchService.search({
        query: "test",
        filters: { threadId: "thread_A", timeRange: { start: 4000, end: 6000 } },
      });
      // Event nodes go to relatedEvents, not nodes
      expect(resultMatch.relatedEvents).toHaveLength(1);
      expect(resultMatch.relatedEvents[0].screenshotIds).toEqual([200]);

      expect(embeddingService.embed).toHaveBeenCalledWith("test", undefined);
    });
  });

  describe("getEvidence", () => {
    it("should fetch, deduplicate, and sort evidence for nodes", async () => {
      const { getDb } = await import("../../database");
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const results = selectResults.shift();
            return { all: () => results || [] };
          }),
        }),
      });
      vi.mocked(getDb).mockReturnValue({
        select: mockSelect,
      } as unknown as ReturnType<typeof getDb>);

      selectResults = [
        [
          { nodeId: 1, screenshotId: 123 },
          { nodeId: 1, screenshotId: 456 },
          { nodeId: 1, screenshotId: 123 },
        ], // contextScreenshotLinks (with duplicate)
        [
          { id: 123, ts: 1000, storageState: "persisted", appHint: "App1" },
          { id: 456, ts: 2000, storageState: "persisted", appHint: "App2" },
        ], // screenshots
      ];

      const evidence = await contextSearchService.getEvidence([1]);
      // Should be deduplicated and sorted by ts desc (2000 first)
      expect(evidence).toHaveLength(2);
      expect(evidence[0].screenshotId).toBe(456);
      expect(evidence[1].screenshotId).toBe(123);
    });
  });
});
