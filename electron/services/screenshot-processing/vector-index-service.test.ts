import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

const createMockIndex = () => ({
  readIndexSync: vi.fn(),
  writeIndexSync: vi.fn(),
  getMaxElements: vi.fn(() => 1000),
  getCurrentCount: vi.fn(() => 2),
  resizeIndex: vi.fn(),
  addPoint: vi.fn(),
  searchKnn: vi.fn(() => ({ distances: [0.1], neighbors: [1] })),
  markDelete: vi.fn(),
  initIndex: vi.fn(),
});

let mockIndex = createMockIndex();
const mockHnsw = vi.hoisted(() => ({
  default: {
    HierarchicalNSW: class {
      constructor() {
        return mockIndex;
      }
    },
  },
}));

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("fs", () => ({ default: mockFs, ...mockFs }));
vi.mock("hnswlib-node", () => mockHnsw);
vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("../../database", () => ({ getDb: mockGetDb }));
vi.mock("./config", () => ({
  processingConfig: {
    vectorStore: {
      indexFilePath: "/tmp/vector_index.bin",
      flushDebounceMs: 100,
      defaultDimensions: 1024,
    },
  },
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, count: vi.fn(() => ({ value: "count" })) };
});

import { VectorIndexService } from "./vector-index-service";

describe("VectorIndexService", () => {
  let service: VectorIndexService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockIndex = createMockIndex();
    mockDb = createDbMock({
      selectSteps: [{ get: null }, { all: [{ value: 10 }] }],
    });
    mockGetDb.mockReturnValue(mockDb);
    service = new VectorIndexService();
  });

  it("creates fresh index when index file does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await service.load();

    expect(mockIndex.initIndex).toHaveBeenCalledWith(5010);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
  });

  it("loads existing index when file exists", async () => {
    mockFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    await service.load();

    expect(mockIndex.readIndexSync).toHaveBeenCalledWith("/tmp/vector_index.bin");
  });

  it("detects dimensions from existing embedding buffer", async () => {
    mockDb = createDbMock({
      selectSteps: [{ get: { embedding: Buffer.alloc(8) } }, { all: [{ value: 10 }] }],
    });
    mockGetDb.mockReturnValue(mockDb);
    mockFs.existsSync.mockReturnValue(false);

    await service.load();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ detectedDimensions: 2 }),
      "Detected embedding dimensions from database"
    );
  });

  it("reuses in-flight load promise", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await Promise.all([service.load(), service.load()]);

    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("resizes existing index on load when capacity is insufficient", async () => {
    mockFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockIndex.getMaxElements.mockReturnValue(100);

    await service.load();

    expect(mockIndex.resizeIndex).toHaveBeenCalledWith(5010);
  });

  it("rebuilds index when loading existing file fails", async () => {
    mockFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockIndex.readIndexSync.mockImplementation(() => {
      throw new Error("corrupt index");
    });

    await service.load();

    expect(mockIndex.initIndex).toHaveBeenCalledWith(5010);
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      "Failed to load index from file, creating fresh index"
    );
  });

  it("upserts embedding into index", async () => {
    await service.load();
    const embedding = new Float32Array(1024).fill(0.2);

    await service.upsert(11, embedding);

    expect(mockIndex.addPoint).toHaveBeenCalledWith(Array.from(embedding), 11);
  });

  it("throws and resets embeddings on dimension mismatch", async () => {
    await service.load();
    const embedding = new Float32Array(512).fill(0.2);

    await expect(service.upsert(11, embedding)).rejects.toThrow("Dimension migration triggered");
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("returns search results as docId/score pairs", async () => {
    await service.load();
    const result = await service.search(new Float32Array(1024).fill(0.1), 1);

    expect(result).toEqual([{ docId: 1, score: 0.1 }]);
  });

  it("returns empty results for query dimension mismatch", async () => {
    await service.load();
    const result = await service.search(new Float32Array(256).fill(0.1), 1);

    expect(result).toEqual([]);
  });

  it("returns empty results when index has no vectors", async () => {
    await service.load();
    mockIndex.getCurrentCount.mockReturnValue(0);

    const result = await service.search(new Float32Array(1024).fill(0.1), 5);
    expect(result).toEqual([]);
  });

  it("resizes during upsert when index is full", async () => {
    await service.load();
    mockIndex.getCurrentCount.mockReturnValue(1000);
    mockIndex.getMaxElements.mockReturnValue(1000);

    await service.upsert(12, new Float32Array(1024).fill(0.4));

    expect(mockIndex.resizeIndex).toHaveBeenCalledWith(6000);
  });

  it("resets embeddings when addPoint throws dimensions mismatch", async () => {
    await service.load();
    mockIndex.addPoint.mockImplementation(() => {
      throw new Error("dimensions mismatch");
    });

    await expect(service.upsert(13, new Float32Array(1024).fill(0.2))).rejects.toThrow(
      "dimensions mismatch"
    );
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("rethrows search errors", async () => {
    await service.load();
    mockIndex.searchKnn.mockImplementation(() => {
      throw new Error("search failed");
    });

    await expect(service.search(new Float32Array(1024).fill(0.1), 3)).rejects.toThrow(
      "search failed"
    );
  });

  it("marks doc deleted only when index is loaded", async () => {
    await service.remove(1);
    expect(mockIndex.markDelete).not.toHaveBeenCalled();

    await service.load();
    await service.remove(1);
    expect(mockIndex.markDelete).toHaveBeenCalledWith(1);
  });

  it("swallows remove errors", async () => {
    await service.load();
    mockIndex.markDelete.mockImplementation(() => {
      throw new Error("not found");
    });

    await service.remove(999);
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it("flushes index to disk", async () => {
    await service.load();
    await service.flush();
    expect(mockIndex.writeIndexSync).toHaveBeenCalledWith("/tmp/vector_index.bin");
  });

  it("throws when flush fails", async () => {
    await service.load();
    mockIndex.writeIndexSync.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(service.flush()).rejects.toThrow("disk full");
  });

  it("debounces requestFlush", async () => {
    vi.useFakeTimers();
    await service.load();

    service.requestFlush();
    service.requestFlush();
    expect(mockIndex.writeIndexSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(mockIndex.writeIndexSync).toHaveBeenCalledTimes(1);
  });

  it("logs debounced flush failure", async () => {
    vi.useFakeTimers();
    await service.load();
    mockIndex.writeIndexSync.mockImplementation(() => {
      throw new Error("disk full");
    });

    service.requestFlush();
    await vi.advanceTimersByTimeAsync(100);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      "Debounced flush failed"
    );
  });
});
