import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("../../database", () => ({ getDb: mockGetDb }));
vi.mock("../../database/schema", () => ({
  contextNodes: {
    id: "id",
    threadId: "threadId",
    eventTime: "eventTime",
    createdAt: "createdAt",
    title: "title",
    summary: "summary",
    keywords: "keywords",
    entities: "entities",
    appContext: "appContext",
    knowledge: "knowledge",
    stateSnapshot: "stateSnapshot",
    uiTextSnippets: "uiTextSnippets",
    importance: "importance",
    confidence: "confidence",
    batchId: "batchId",
  },
  contextScreenshotLinks: { nodeId: "nodeId", screenshotId: "screenshotId" },
  screenshots: { id: "id", ts: "ts", appHint: "appHint", windowTitle: "windowTitle" },
  screenshotsFts: { rowid: "rowid" },
  vectorDocuments: { id: "id", refId: "refId" },
}));
vi.mock("./embedding-service", () => ({
  embeddingService: { embed: vi.fn().mockResolvedValue(new Float32Array(3)) },
}));
vi.mock("./vector-index-service", () => ({
  vectorIndexService: { search: vi.fn().mockResolvedValue([]) },
}));
vi.mock("./deep-search-service", () => ({
  deepSearchService: {
    understandQuery: vi.fn().mockResolvedValue(null),
    mergeFilters: vi.fn().mockReturnValue(undefined),
    synthesizeAnswer: vi.fn().mockResolvedValue(null),
  },
}));

import { ContextSearchService } from "./context-search-service";

describe("ContextSearchService", () => {
  let service: ContextSearchService;

  const nodeRow = {
    id: 1,
    batchId: 1,
    threadId: "t1",
    title: "Title",
    summary: "Summary",
    appContext: JSON.stringify({ appHint: "vscode", windowTitle: "editor", sourceKey: "s" }),
    knowledge: null,
    stateSnapshot: null,
    uiTextSnippets: "[]",
    keywords: "[]",
    entities: "[]",
    importance: 5,
    confidence: 5,
    eventTime: 1000,
    createdAt: 1000,
    threadSnapshot: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ContextSearchService();
  });

  it("returns empty result for blank query", async () => {
    expect(await service.search("")).toEqual({ nodes: [], relatedEvents: [], evidence: [] });
    expect(await service.search("   ")).toEqual({ nodes: [], relatedEvents: [], evidence: [] });
  });

  it("returns nodes for non-empty query", async () => {
    mockDb = createDbMock({
      selectSteps: [
        { all: [nodeRow] }, // keyword direct
        { all: [] }, // fts
        { all: [{ nodeId: 1, screenshotId: 11 }] }, // screenshot links
        { all: [{ id: 11, ts: 123, appHint: "vscode", windowTitle: "editor" }] }, // evidence
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.search("debug");
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  it("loads thread nodes", async () => {
    mockDb = createDbMock({
      selectSteps: [
        { all: [nodeRow] }, // nodes
        { all: [] }, // links
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const nodes = await service.getThread("t1", { limit: 10 });
    expect(nodes[0]?.threadId).toBe("t1");
  });

  it("returns evidence list", async () => {
    mockDb = createDbMock({
      selectSteps: [
        { all: [{ nodeId: 1, screenshotId: 11 }] },
        { all: [{ id: 11, ts: 1, appHint: null, windowTitle: null }] },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const evidence = await service.getEvidence([1]);
    expect(evidence).toEqual([
      { screenshotId: 11, timestamp: 1, appHint: undefined, windowTitle: undefined },
    ]);
  });

  it("returns empty evidence for empty nodeIds", async () => {
    const evidence = await service.getEvidence([]);
    expect(evidence).toEqual([]);
  });

  it("returns empty thread for blank threadId", async () => {
    const nodes = await service.getThread("", { limit: 10 });
    expect(nodes).toEqual([]);
  });

  it("search respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    mockDb = createDbMock({
      selectSteps: [{ all: [] }, { all: [] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.search("test query", controller.signal);
    expect(result.nodes).toEqual([]);
  });

  it("search with query plan from deep search", async () => {
    const { deepSearchService } = await import("./deep-search-service");
    vi.mocked(deepSearchService.understandQuery).mockResolvedValue({
      confidence: 0.9,
      embeddingText: "refined query",
      filtersPatch: { appHint: "vscode" },
    });
    vi.mocked(deepSearchService.mergeFilters).mockReturnValue({
      appHint: "vscode",
    });

    mockDb = createDbMock({
      selectSteps: [
        { all: [nodeRow] },
        { all: [] },
        { all: [{ nodeId: 1, screenshotId: 11 }] },
        { all: [{ id: 11, ts: 123, appHint: "vscode", windowTitle: "editor" }] },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.search("vscode debug");
    expect(result.queryPlan).toBeDefined();
  });

  it("handles multiple nodes with different kinds", async () => {
    const eventNode = {
      ...nodeRow,
      id: 2,
      kind: "event",
      eventTime: 2000,
    };
    mockDb = createDbMock({
      selectSteps: [{ all: [nodeRow, eventNode] }, { all: [] }, { all: [] }, { all: [] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.search("test");
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.relatedEvents)).toBe(true);
  });
});
