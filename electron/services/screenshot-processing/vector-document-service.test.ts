import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockEventBus = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("./event-bus", () => ({ screenshotProcessingEventBus: mockEventBus }));
vi.mock("../../database", () => ({ getDb: mockGetDb }));
vi.mock("../../database/schema", () => ({
  contextNodes: { id: "id", threadId: "threadId", eventTime: "eventTime", batchId: "batchId" },
  vectorDocuments: { id: "id", vectorId: "vectorId" },
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, eq: vi.fn(() => ({})) };
});

import { VectorDocumentService } from "./vector-document-service";

describe("VectorDocumentService", () => {
  let service: VectorDocumentService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VectorDocumentService();
  });

  it("creates a new vector document", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          get: {
            id: 1,
            title: "T",
            summary: "S",
            keywords: null,
            knowledge: null,
            stateSnapshot: null,
          },
        },
        {
          get: {
            id: 1,
            title: "T",
            summary: "S",
            keywords: null,
            knowledge: null,
            stateSnapshot: null,
          },
        },
        { get: { id: 1, threadId: "th-1", eventTime: 100, batchId: 3 } },
        { get: null },
      ],
      insertSteps: [{ get: { id: 88 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.upsertForContextNode(1);

    expect(result).toEqual({ vectorDocumentId: 88, vectorId: "node:1" });
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      "vector-documents:dirty",
      expect.objectContaining({ vectorDocumentId: 88, nodeId: 1 })
    );
  });

  it("updates existing vector document when hash changes", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          get: {
            id: 1,
            title: "T",
            summary: "S2",
            keywords: null,
            knowledge: null,
            stateSnapshot: null,
          },
        },
        {
          get: {
            id: 1,
            title: "T",
            summary: "S2",
            keywords: null,
            knowledge: null,
            stateSnapshot: null,
          },
        },
        { get: { id: 1, threadId: "th-1", eventTime: 100, batchId: 3 } },
        { get: { id: 88, vectorId: "node:1", textHash: "old" } },
      ],
      updateSteps: [{ get: { id: 88 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.upsertForContextNode(1);

    expect(result.vectorDocumentId).toBe(88);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("throws when context node does not exist", async () => {
    mockDb = createDbMock({ selectSteps: [{ get: null }] });
    mockGetDb.mockReturnValue(mockDb);

    await expect(service.upsertForContextNode(999)).rejects.toThrow("Context node not found: 999");
  });

  it("builds searchable text with optional fields", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          get: {
            id: 2,
            title: "Title",
            summary: "Summary",
            keywords: JSON.stringify(["a", "b"]),
            knowledge: '{"k":1}',
            stateSnapshot: '{"s":1}',
          },
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const text = await service.buildTextForNode(2);
    expect(text).toContain("Title: Title");
    expect(text).toContain("Keywords: a, b");
    expect(text).toContain("Knowledge:");
  });
});
