import { describe, it, expect, vi } from "vitest";

vi.mock("../../database", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../database/schema", () => ({
  batches: {},
  screenshots: {},
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("./event-bus", () => ({
  screenshotProcessingEventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import { BatchBuilder } from "./batch-builder";
import type { AcceptedScreenshot } from "./types";

function makeScreenshot(
  overrides: Partial<AcceptedScreenshot> & { id: number }
): AcceptedScreenshot {
  return {
    ts: Date.now(),
    sourceKey: "screen:0",
    phash: "0000000000000000",
    filePath: "/tmp/test.png",
    meta: {},
    ...overrides,
  };
}

describe("BatchBuilder.createBatch", () => {
  const builder = new BatchBuilder();

  it("throws when given empty screenshots array", () => {
    expect(() => builder.createBatch("screen:0", [])).toThrow(
      "Cannot create batch with empty screenshots"
    );
  });

  it("creates a batch with correct sourceKey", () => {
    const screenshots = [makeScreenshot({ id: 1, ts: 1000 })];
    const batch = builder.createBatch("screen:0", screenshots);

    expect(batch.sourceKey).toBe("screen:0");
  });

  it("sorts screenshots by timestamp", () => {
    const screenshots = [
      makeScreenshot({ id: 3, ts: 3000 }),
      makeScreenshot({ id: 1, ts: 1000 }),
      makeScreenshot({ id: 2, ts: 2000 }),
    ];

    const batch = builder.createBatch("screen:0", screenshots);

    expect(batch.screenshots.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("sets tsStart and tsEnd from sorted screenshots", () => {
    const screenshots = [makeScreenshot({ id: 2, ts: 5000 }), makeScreenshot({ id: 1, ts: 1000 })];

    const batch = builder.createBatch("screen:0", screenshots);

    expect(batch.tsStart).toBe(1000);
    expect(batch.tsEnd).toBe(5000);
  });

  it("generates a deterministic batchId for same input", () => {
    const screenshots = [makeScreenshot({ id: 1, ts: 1000 }), makeScreenshot({ id: 2, ts: 2000 })];

    const batch1 = builder.createBatch("screen:0", screenshots);
    const batch2 = builder.createBatch("screen:0", screenshots);

    expect(batch1.batchId).toBe(batch2.batchId);
  });

  it("generates different batchIds for different inputs", () => {
    const batch1 = builder.createBatch("screen:0", [makeScreenshot({ id: 1, ts: 1000 })]);
    const batch2 = builder.createBatch("screen:0", [makeScreenshot({ id: 2, ts: 2000 })]);

    expect(batch1.batchId).not.toBe(batch2.batchId);
  });

  it("batchId starts with 'batch_' prefix", () => {
    const batch = builder.createBatch("screen:0", [makeScreenshot({ id: 1, ts: 1000 })]);
    expect(batch.batchId).toMatch(/^batch_[a-f0-9]{24}$/);
  });

  it("handles single screenshot", () => {
    const screenshots = [makeScreenshot({ id: 1, ts: 1000 })];
    const batch = builder.createBatch("screen:0", screenshots);

    expect(batch.screenshots).toHaveLength(1);
    expect(batch.tsStart).toBe(1000);
    expect(batch.tsEnd).toBe(1000);
  });

  it("does not mutate the original array", () => {
    const screenshots = [makeScreenshot({ id: 2, ts: 2000 }), makeScreenshot({ id: 1, ts: 1000 })];
    const originalOrder = screenshots.map((s) => s.id);

    builder.createBatch("screen:0", screenshots);

    expect(screenshots.map((s) => s.id)).toEqual(originalOrder);
  });

  it("works with window source keys", () => {
    const screenshots = [makeScreenshot({ id: 1, ts: 1000, sourceKey: "window:vscode" })];
    const batch = builder.createBatch("window:vscode", screenshots);

    expect(batch.sourceKey).toBe("window:vscode");
  });
});

describe("BatchBuilder.createAndPersistBatch", () => {
  const builder = new BatchBuilder();

  it("creates batch and persists to database", async () => {
    const { getDb } = await import("../../database");
    const mockTx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            get: vi.fn(() => ({ id: 42 })),
          })),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            all: vi.fn(() => []),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            run: vi.fn(),
          })),
        })),
      })),
    };
    vi.mocked(getDb).mockReturnValue({
      transaction: vi.fn((fn) => fn(mockTx)),
    } as ReturnType<typeof getDb>);

    const screenshots = [makeScreenshot({ id: 1, ts: 1000 })];
    const result = await builder.createAndPersistBatch("screen:0", screenshots);

    expect(result.batch.sourceKey).toBe("screen:0");
    expect(result.dbId).toBe(42);
  });

  it("handles insert conflict by looking up existing batch", async () => {
    const { getDb } = await import("../../database");
    let insertCallCount = 0;
    const mockTx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            get: vi.fn(() => {
              insertCallCount++;
              if (insertCallCount === 1) throw new Error("UNIQUE constraint failed");
              return { id: 99 };
            }),
          })),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(() => ({ id: 99 })),
            all: vi.fn(() => []),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            run: vi.fn(),
          })),
        })),
      })),
    };
    vi.mocked(getDb).mockReturnValue({
      transaction: vi.fn((fn) => fn(mockTx)),
    } as ReturnType<typeof getDb>);

    const screenshots = [makeScreenshot({ id: 1, ts: 1000 })];
    const result = await builder.createAndPersistBatch("screen:0", screenshots);
    expect(result.dbId).toBe(99);
  });
});
