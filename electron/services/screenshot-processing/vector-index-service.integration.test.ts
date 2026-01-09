import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VectorIndexService } from "./vector-index-service";
import { processingConfig } from "./config";

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

// Minimal DB mock to satisfy vector-index-service load/reset calls
const mockEmbeddingBuffer = Buffer.from(new Float32Array([0, 0, 0, 0]).buffer);

const mockDb = {
  select: vi.fn((fields?: unknown) => ({
    from: vi.fn(() => ({
      all: vi.fn(() => [{ value: 0 }]),
      where: vi.fn(() => ({
        limit: vi.fn(() => ({
          get: vi.fn(() => {
            if (fields && typeof fields === "object" && "embedding" in (fields as object)) {
              return { embedding: mockEmbeddingBuffer };
            }
            return null;
          }),
        })),
      })),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        run: vi.fn(() => ({ changes: 0 })),
      })),
    })),
  })),
};

vi.mock("../../database", () => ({
  getDb: () => mockDb,
}));

describe("VectorIndexService (integration with hnswlib-node)", () => {
  const originalConfig = { ...processingConfig.vectorStore };
  let tmpDir: string;
  let service: VectorIndexService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hnsw-test-"));
    processingConfig.vectorStore.indexFilePath = path.join(tmpDir, "index.bin");

    service = new VectorIndexService();
    mockDb.select.mockClear();
    mockDb.update.mockClear();
  });

  afterEach(() => {
    processingConfig.vectorStore.indexFilePath = originalConfig.indexFilePath;

    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("overwrites vectors and persists across flush/load", async () => {
    await service.load();
    await service.upsert(1, new Float32Array([1, 1, 1, 1]));
    await service.flush();

    await service.upsert(1, new Float32Array([2, 2, 2, 2])); // overwrite same docId
    await service.flush();

    const serviceReloaded = new VectorIndexService();
    await serviceReloaded.load(); // reads the flushed index

    const result = await serviceReloaded.search(new Float32Array([2, 2, 2, 2]), 1);
    expect(result[0]?.docId).toBe(1);
  });

  it("supports delete then re-add of the same docId", async () => {
    await service.load();
    await service.upsert(1, new Float32Array([1, 1, 1, 1]));
    await service.flush();

    await service.remove(1);
    await service.upsert(1, new Float32Array([3, 3, 3, 3]));
    await service.flush();

    const result = await service.search(new Float32Array([3, 3, 3, 3]), 1);
    expect(result[0]?.docId).toBe(1);
  });

  // Dimension checks have been removed - the service now dynamically detects dimensions
  // from existing embeddings in the database
});
