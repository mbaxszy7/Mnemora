/**
 * Context Graph Service Tests
 *
 * Tests for ContextGraphService including:
 * - Unit tests for core functionality
 * - Integration tests for CP-8 (derived node source edges) and CP-9 (embedding_status initialization)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ContextKind, EdgeType, ContextNodeRecord } from "../../database/schema";
import { ContextGraphService, type CreateNodeInput } from "./context-graph-service";

// ============================================================================
// Mock Setup
// ============================================================================

// Track insert calls for verification
let insertCalls: Array<{ values: Record<string, unknown> }> = [];
let updateCalls: Array<{ values: Record<string, unknown> }> = [];
let selectResults: unknown[] = [];
let insertReturnId = 1;
let originKeyToId = new Map<string, number>();

// Mock the database module
vi.mock("../../database", () => ({
  getDb: () => ({
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown> | Record<string, unknown>[]) => {
        if (Array.isArray(values)) {
          values.forEach((v) => insertCalls.push({ values: v }));
        } else {
          insertCalls.push({ values });
        }

        const nextIdForValues = (v: Record<string, unknown>): number => {
          const originKey = v.originKey;
          if (typeof originKey === "string" && originKey.length > 0) {
            const existing = originKeyToId.get(originKey);
            if (existing) return existing;
            const id = insertReturnId++;
            originKeyToId.set(originKey, id);
            return id;
          }
          return insertReturnId++;
        };

        const returningId = Array.isArray(values)
          ? nextIdForValues(values[0] ?? {})
          : nextIdForValues(values);

        return {
          returning: vi.fn(() => ({
            all: vi.fn(() => [{ id: returningId }]),
            get: vi.fn(() => ({ id: returningId })),
          })),
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(() => ({
              get: vi.fn(() => ({ id: returningId })),
            })),
          })),
          onConflictDoNothing: vi.fn(() => ({
            run: vi.fn(),
          })),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ values });
        return {
          where: vi.fn(() => ({
            run: vi.fn(),
          })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => selectResults),
          orderBy: vi.fn(() => ({
            all: vi.fn(() => selectResults),
          })),
          limit: vi.fn(() => ({
            all: vi.fn(() => selectResults),
          })),
        })),
        orderBy: vi.fn(() => ({
          all: vi.fn(() => selectResults),
        })),
        limit: vi.fn(() => ({
          all: vi.fn(() => selectResults),
        })),
        all: vi.fn(() => selectResults),
      })),
    })),
  }),
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ============================================================================
// Test Helpers
// ============================================================================

function createTestNodeInput(overrides: Partial<CreateNodeInput> = {}): CreateNodeInput {
  return {
    kind: "event",
    title: "Test Event",
    summary: "This is a test event summary",
    keywords: ["test", "event"],
    entities: [{ name: "TestEntity", entityType: "project" }],
    importance: 7,
    confidence: 8,
    eventTime: Date.now(),
    ...overrides,
  };
}

function resetMocks() {
  insertCalls = [];
  updateCalls = [];
  selectResults = [];
  insertReturnId = 1;
  originKeyToId = new Map<string, number>();
}

// Helper to find insert call by checking values
function findNodeInsert() {
  return insertCalls.find((c) => c.values.kind !== undefined);
}

function findEdgeInsert() {
  return insertCalls.find((c) => c.values.edgeType !== undefined);
}

function findLinkInserts() {
  return insertCalls.filter(
    (c) => c.values.screenshotId !== undefined && c.values.nodeId !== undefined
  );
}

function buildRecord(overrides: Partial<ContextNodeRecord> = {}): ContextNodeRecord {
  const now = Date.now();
  return {
    id: 1,
    kind: "event",
    threadId: null,
    originKey: null,
    title: "Test Event",
    summary: "Test summary",
    keywords: null,
    entities: null,
    importance: 5,
    confidence: 5,
    eventTime: null,
    mergedFromIds: null,
    payloadJson: null,
    mergeStatus: "pending",
    mergeAttempts: 0,
    mergeNextRunAt: null,
    mergeErrorCode: null,
    mergeErrorMessage: null,
    embeddingStatus: "pending",
    embeddingAttempts: 0,
    embeddingNextRunAt: null,
    embeddingErrorCode: null,
    embeddingErrorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("ContextGraphService", () => {
  let service: ContextGraphService;

  beforeEach(() => {
    service = new ContextGraphService();
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  describe("createNode", () => {
    it("should create a node and return its ID", async () => {
      const input = createTestNodeInput();
      const nodeId = await service.createNode(input);
      expect(nodeId).toBe("1");
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("should be idempotent for same originKey", async () => {
      const input = createTestNodeInput({
        originKey: "ctx_node:test:stable",
        title: "First",
        summary: "First summary",
      });

      const id1 = await service.createNode(input);
      const id2 = await service.createNode({
        ...input,
        title: "Second",
        summary: "Second summary",
      });

      expect(id1).toBe("1");
      expect(id2).toBe("1");
    });

    it("should set correct fields on the node", async () => {
      const input = createTestNodeInput({
        title: "My Title",
        summary: "My Summary",
        importance: 9,
        confidence: 10,
      });
      await service.createNode(input);
      const nodeInsert = findNodeInsert();
      expect(nodeInsert).toBeDefined();
      expect(nodeInsert!.values.title).toBe("My Title");
      expect(nodeInsert!.values.summary).toBe("My Summary");
      expect(nodeInsert!.values.importance).toBe(9);
      expect(nodeInsert!.values.confidence).toBe(10);
    });

    it("should use default values for importance and confidence", async () => {
      const input: CreateNodeInput = {
        kind: "event",
        title: "Test",
        summary: "Test summary",
      };
      await service.createNode(input);
      const nodeInsert = findNodeInsert();
      expect(nodeInsert!.values.importance).toBe(5);
      expect(nodeInsert!.values.confidence).toBe(5);
    });

    it("CP-9: should set embedding_status to pending on creation", async () => {
      const input = createTestNodeInput();
      await service.createNode(input);
      const nodeInsert = findNodeInsert();
      expect(nodeInsert).toBeDefined();
      expect(nodeInsert!.values.embeddingStatus).toBe("pending");
    });

    describe("CP-8: Derived node source edges", () => {
      it("should throw error for derived node without sourceEventId", async () => {
        const input = createTestNodeInput({
          kind: "knowledge",
          title: "Test Knowledge",
          summary: "Test summary",
        });
        await expect(service.createNode(input)).rejects.toThrow(
          "Derived node of kind 'knowledge' requires sourceEventId"
        );
      });

      it("should create derived node with sourceEventId", async () => {
        const input = createTestNodeInput({
          kind: "knowledge",
          title: "Test Knowledge",
          summary: "Test summary",
          sourceEventId: 100,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeDefined();
        expect(edgeInsert!.values.fromNodeId).toBe(100);
        expect(edgeInsert!.values.toNodeId).toBe(1);
        expect(edgeInsert!.values.edgeType).toBe("event_produces_knowledge");
      });

      it("should create event_next edge for event in thread", async () => {
        selectResults = [
          {
            id: 10,
            kind: "event",
            threadId: "thread_1",
            title: "Previous Event",
            summary: "Previous summary",
            keywords: null,
            entities: null,
            importance: 5,
            confidence: 5,
            eventTime: 1000,
            mergedFromIds: null,
            payloadJson: null,
            mergeStatus: "pending",
            embeddingStatus: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ];
        const input = createTestNodeInput({
          kind: "event",
          threadId: "thread_1",
          title: "Current Event",
          summary: "Current summary",
          eventTime: 2000,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeDefined();
        expect(edgeInsert!.values.fromNodeId).toBe(10);
        expect(edgeInsert!.values.toNodeId).toBe(1);
        expect(edgeInsert!.values.edgeType).toBe("event_next");
      });

      it("should not create event_next edge for first event in thread", async () => {
        selectResults = [];
        const input = createTestNodeInput({
          kind: "event",
          threadId: "thread_1",
          title: "First Event",
          summary: "First summary",
          eventTime: 1000,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeUndefined();
      });

      it("should not create event_next edge for event without threadId", async () => {
        const input = createTestNodeInput({
          kind: "event",
          title: "Event without thread",
          summary: "Summary",
          eventTime: 1000,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeUndefined();
      });

      it("should create edge for knowledge node with sourceEventId", async () => {
        const input = createTestNodeInput({
          kind: "knowledge",
          sourceEventId: 100,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeDefined();
        expect(edgeInsert!.values.fromNodeId).toBe(100);
        expect(edgeInsert!.values.toNodeId).toBe(1);
        expect(edgeInsert!.values.edgeType).toBe("event_produces_knowledge");
      });

      it("should create edge for state_snapshot node with sourceEventId", async () => {
        const input = createTestNodeInput({
          kind: "state_snapshot",
          sourceEventId: 100,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeDefined();
        expect(edgeInsert!.values.fromNodeId).toBe(100);
        expect(edgeInsert!.values.toNodeId).toBe(1);
        expect(edgeInsert!.values.edgeType).toBe("event_updates_state");
      });

      it("should create edge for procedure node with sourceEventId", async () => {
        const input = createTestNodeInput({
          kind: "procedure",
          sourceEventId: 100,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeDefined();
        expect(edgeInsert!.values.edgeType).toBe("event_uses_procedure");
      });

      it("should create edge for plan node with sourceEventId", async () => {
        const input = createTestNodeInput({
          kind: "plan",
          sourceEventId: 100,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeDefined();
        expect(edgeInsert!.values.edgeType).toBe("event_suggests_plan");
      });

      it("should NOT create edge for event node (not a derived type)", async () => {
        const input = createTestNodeInput({
          kind: "event",
          sourceEventId: 100,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeUndefined();
      });

      it("should NOT create edge for entity_profile node (not a derived type)", async () => {
        const input = createTestNodeInput({
          kind: "entity_profile",
          sourceEventId: 100,
        });
        await service.createNode(input);
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeUndefined();
      });
    });

    it("should link screenshots when screenshotIds provided", async () => {
      const input = createTestNodeInput({
        screenshotIds: [1, 2, 3],
      });
      await service.createNode(input);
      const linkInserts = findLinkInserts();
      expect(linkInserts).toHaveLength(3);
    });

    it("should serialize keywords and entities as JSON", async () => {
      const input = createTestNodeInput({
        keywords: ["key1", "key2"],
        entities: [{ name: "Entity1" }, { name: "Entity2" }],
      });
      await service.createNode(input);
      const nodeInsert = findNodeInsert();
      expect(nodeInsert!.values.keywords).toBe(JSON.stringify(["key1", "key2"]));
      expect(nodeInsert!.values.entities).toBe(
        JSON.stringify([{ name: "Entity1" }, { name: "Entity2" }])
      );
    });
  });

  describe("updateNode", () => {
    it("should update node with provided fields", async () => {
      await service.updateNode("1", {
        title: "Updated Title",
        summary: "Updated Summary",
      });
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].values.title).toBe("Updated Title");
      expect(updateCalls[0].values.summary).toBe("Updated Summary");
    });

    it("should throw error for invalid node ID", async () => {
      await expect(service.updateNode("invalid", { title: "Test" })).rejects.toThrow(
        "Invalid node ID"
      );
    });

    it("should update embedding_status when provided", async () => {
      await service.updateNode("1", {
        embeddingStatus: "succeeded",
      });
      expect(updateCalls[0].values.embeddingStatus).toBe("succeeded");
    });

    it("should always update updatedAt timestamp", async () => {
      const beforeUpdate = Date.now();
      await service.updateNode("1", { title: "Test" });
      const afterUpdate = Date.now();
      const updatedAt = updateCalls[0].values.updatedAt as number;
      expect(updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
      expect(updatedAt).toBeLessThanOrEqual(afterUpdate);
    });
  });

  describe("createEdge", () => {
    it("should create edge between nodes", async () => {
      await service.createEdge("1", "2", "event_next");
      const edgeInsert = findEdgeInsert();
      expect(edgeInsert).toBeDefined();
      expect(edgeInsert!.values.fromNodeId).toBe(1);
      expect(edgeInsert!.values.toNodeId).toBe(2);
      expect(edgeInsert!.values.edgeType).toBe("event_next");
    });

    it("should throw error for invalid fromId", async () => {
      await expect(service.createEdge("invalid", "2", "event_next")).rejects.toThrow(
        "Invalid node IDs"
      );
    });

    it("should throw error for invalid toId", async () => {
      await expect(service.createEdge("1", "invalid", "event_next")).rejects.toThrow(
        "Invalid node IDs"
      );
    });
  });

  describe("linkScreenshot", () => {
    it("should link screenshot to node", async () => {
      await service.linkScreenshot("1", "100");
      const linkInserts = findLinkInserts();
      expect(linkInserts).toHaveLength(1);
      expect(linkInserts[0].values.nodeId).toBe(1);
      expect(linkInserts[0].values.screenshotId).toBe(100);
    });

    it("should throw error for invalid nodeId", async () => {
      await expect(service.linkScreenshot("invalid", "100")).rejects.toThrow("Invalid IDs");
    });

    it("should throw error for invalid screenshotId", async () => {
      await expect(service.linkScreenshot("1", "invalid")).rejects.toThrow("Invalid IDs");
    });
  });

  describe("getThread", () => {
    it("should return event nodes for thread", async () => {
      const mockNodes = [
        { id: 1, kind: "event", threadId: "thread_1", title: "Event 1" },
        { id: 2, kind: "event", threadId: "thread_1", title: "Event 2" },
      ];
      selectResults = mockNodes;
      const nodes = await service.getThread("thread_1");
      expect(nodes).toEqual(mockNodes);
    });

    it("should return empty array for non-existent thread", async () => {
      selectResults = [];
      const nodes = await service.getThread("non_existent");
      expect(nodes).toEqual([]);
    });
  });

  describe("getNode (internal helper)", () => {
    it("should return node by ID", () => {
      const mockNode = { id: 1, kind: "event", title: "Test" };
      selectResults = [mockNode];
      const node = service.getNode("1");
      expect(node).toEqual(mockNode);
    });

    it("should return null for invalid ID", () => {
      const node = service.getNode("invalid");
      expect(node).toBeNull();
    });

    it("should return null for non-existent node", () => {
      selectResults = [];
      const node = service.getNode("999");
      expect(node).toBeNull();
    });
  });

  describe("traverse", () => {
    it("should throw error for invalid node ID", async () => {
      await expect(service.traverse("invalid", ["event_next"], 2)).rejects.toThrow(
        "Invalid node ID"
      );
    });

    it("should return GraphTraversalResult with nodes, edges, and screenshotIds", async () => {
      selectResults = [];
      const result = await service.traverse("1", ["event_next"], 1);
      expect(result).toHaveProperty("nodes");
      expect(result).toHaveProperty("edges");
      expect(result).toHaveProperty("screenshotIds");
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
      expect(Array.isArray(result.screenshotIds)).toBe(true);
    });
  });

  describe("getNodesByIds (internal helper)", () => {
    it("should return nodes by IDs", () => {
      const mockNodes = [
        { id: 1, title: "Node 1" },
        { id: 2, title: "Node 2" },
      ];
      selectResults = mockNodes;
      const nodes = service.getNodesByIds(["1", "2"]);
      expect(nodes).toEqual(mockNodes);
    });

    it("should return empty array for empty input", () => {
      const nodes = service.getNodesByIds([]);
      expect(nodes).toEqual([]);
    });

    it("should filter out invalid IDs", () => {
      selectResults = [];
      const nodes = service.getNodesByIds(["invalid", "also_invalid"]);
      expect(nodes).toEqual([]);
    });
  });

  describe("getLinkedScreenshots (internal helper)", () => {
    it("should return screenshot IDs linked to node", () => {
      selectResults = [{ screenshotId: 100 }, { screenshotId: 101 }];
      const screenshotIds = service.getLinkedScreenshots("1");
      expect(screenshotIds).toEqual([100, 101]);
    });

    it("should return empty array for invalid node ID", () => {
      const screenshotIds = service.getLinkedScreenshots("invalid");
      expect(screenshotIds).toEqual([]);
    });
  });

  describe("getPendingEmbeddingNodes", () => {
    it("should return nodes with pending embedding status", async () => {
      const mockNodes = [
        { id: 1, embeddingStatus: "pending" },
        { id: 2, embeddingStatus: "pending" },
      ];
      selectResults = mockNodes;
      const nodes = await service.getPendingEmbeddingNodes();
      expect(nodes).toEqual(mockNodes);
    });
  });

  describe("recordToExpandedNode", () => {
    it("should convert record to expanded node", () => {
      const record = buildRecord({
        kind: "event",
        threadId: "thread_1",
        keywords: JSON.stringify(["test", "event"]),
        entities: JSON.stringify([{ name: "Entity1" }]),
        importance: 7,
        confidence: 8,
        eventTime: 1234567890,
        mergedFromIds: JSON.stringify([10, 11]),
      });
      const expanded = service.recordToExpandedNode(record);
      expect(expanded.kind).toBe("event");
      expect(expanded.threadId).toBe("thread_1");
      expect(expanded.title).toBe("Test Event");
      expect(expanded.summary).toBe("Test summary");
      expect(expanded.keywords).toEqual(["test", "event"]);
      expect(expanded.entities).toEqual([{ name: "Entity1" }]);
      expect(expanded.importance).toBe(7);
      expect(expanded.confidence).toBe(8);
      expect(expanded.eventTime).toBe(1234567890);
      expect(expanded.mergedFromIds).toEqual([10, 11]);
    });

    it("should handle null JSON fields with safe parsing", () => {
      const record = buildRecord({
        threadId: null,
        title: "Test",
        summary: "Summary",
        keywords: null,
        entities: null,
        eventTime: null,
        mergedFromIds: null,
      });
      const expanded = service.recordToExpandedNode(record);
      expect(expanded.threadId).toBeUndefined();
      expect(expanded.keywords).toEqual([]);
      expect(expanded.entities).toEqual([]);
      expect(expanded.eventTime).toBeUndefined();
      expect(expanded.mergedFromIds).toBeUndefined();
    });

    it("should handle malformed JSON with safe parsing fallback", () => {
      const record = buildRecord({
        threadId: null,
        title: "Test",
        summary: "Summary",
        keywords: "not valid json",
        entities: "{broken",
        eventTime: null,
        mergedFromIds: null,
      });
      const expanded = service.recordToExpandedNode(record);
      expect(expanded.keywords).toEqual([]);
      expect(expanded.entities).toEqual([]);
    });
  });
});

// ============================================================================
// Integration Tests (CP-8 and CP-9)
// ============================================================================

describe("ContextGraphService Integration Tests", () => {
  let service: ContextGraphService;

  beforeEach(() => {
    service = new ContextGraphService();
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  describe("CP-8: Derived nodes must have source edges", () => {
    const derivedKindsAndEdges: Array<{ kind: ContextKind; edgeType: EdgeType }> = [
      { kind: "knowledge", edgeType: "event_produces_knowledge" },
      { kind: "state_snapshot", edgeType: "event_updates_state" },
      { kind: "procedure", edgeType: "event_uses_procedure" },
      { kind: "plan", edgeType: "event_suggests_plan" },
    ];

    for (const { kind, edgeType } of derivedKindsAndEdges) {
      it(`should create ${edgeType} edge for ${kind} node`, async () => {
        resetMocks();
        await service.createNode({
          kind,
          title: `Test ${kind}`,
          summary: `Test ${kind} summary`,
          sourceEventId: 100,
        });
        const edgeInsert = findEdgeInsert();
        expect(edgeInsert).toBeDefined();
        expect(edgeInsert!.values.fromNodeId).toBe(100);
        expect(edgeInsert!.values.edgeType).toBe(edgeType);
      });

      it(`should throw error for ${kind} node without sourceEventId`, async () => {
        resetMocks();
        await expect(
          service.createNode({
            kind,
            title: `Test ${kind}`,
            summary: `Test ${kind} summary`,
          })
        ).rejects.toThrow(`Derived node of kind '${kind}' requires sourceEventId`);
      });
    }
  });

  describe("CP-9: Embedding status must be pending on creation", () => {
    const allKinds: ContextKind[] = [
      "event",
      "knowledge",
      "state_snapshot",
      "procedure",
      "plan",
      "entity_profile",
    ];

    for (const kind of allKinds) {
      it(`should set embedding_status to pending for ${kind} node`, async () => {
        resetMocks();
        const input: CreateNodeInput & { sourceEventId?: number } = {
          kind,
          title: `Test ${kind}`,
          summary: `Test ${kind} summary`,
        };
        if (["knowledge", "state_snapshot", "procedure", "plan"].includes(kind)) {
          input.sourceEventId = 100;
        }
        await service.createNode(input);
        const nodeInsert = findNodeInsert();
        expect(nodeInsert).toBeDefined();
        expect(nodeInsert!.values.embeddingStatus).toBe("pending");
      });
    }
  });
});
