import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "../test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../../database", () => ({
  getDb: mockGetDb,
}));

vi.mock("../../database/schema", () => ({
  batches: {
    vlmStatus: "vlmStatus",
    threadLlmStatus: "threadLlmStatus",
  },
  screenshots: {
    ocrStatus: "ocrStatus",
  },
  vectorDocuments: {
    embeddingStatus: "embeddingStatus",
    indexStatus: "indexStatus",
  },
  activitySummaries: {
    status: "status",
  },
  activityEvents: {
    detailsStatus: "detailsStatus",
  },
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

import { QueueInspector } from "./queue-inspector";
import type { QueueStatus } from "./monitoring-types";

describe("QueueInspector", () => {
  let inspector: QueueInspector;

  beforeEach(() => {
    vi.clearAllMocks();
    inspector = QueueInspector.getInstance();
  });

  it("aggregates queue counts from db rows", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            { status: "pending", count: 2 },
            { status: "running", count: 1 },
          ],
        },
        {
          all: [
            { status: "pending", count: 3 },
            { status: "failed", count: 2 },
          ],
        },
        {
          all: [
            { status: "pending", count: 4 },
            { status: "failed_permanent", count: 1 },
          ],
        },
        {
          all: [
            { status: "pending", count: 5 },
            { status: "running", count: 6 },
            { status: "failed", count: 2 },
          ],
        },
        {
          all: [
            { status: "pending", count: 7 },
            { status: "failed_permanent", count: 3 },
          ],
        },
        { all: [{ status: "running", count: 9 }] },
        {
          all: [
            { status: "pending", count: 1 },
            { status: "failed", count: 2 },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const status = await inspector.getQueueStatus();

    expect(status.batchesVlm).toEqual({ pending: 2, running: 1, failed: 0 });
    expect(status.screenshotsOcr).toEqual({ pending: 3, running: 0, failed: 2 });
    expect(status.batchesThreadLlm).toEqual({ pending: 4, running: 0, failed: 1 });
    expect(status.vectorDocuments).toEqual({
      embeddingPending: 5,
      embeddingRunning: 6,
      indexPending: 7,
      indexRunning: 0,
      failed: 5,
    });
    expect(status.activitySummaries).toEqual({ pending: 0, running: 9, failed: 0 });
    expect(status.activityEventDetails).toEqual({ pending: 1, running: 0, failed: 2 });
  });

  it("returns zeroed status when db access fails", async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error("db unavailable");
    });

    const status = await inspector.getQueueStatus();

    expect(status.batchesVlm).toEqual({ pending: 0, running: 0, failed: 0 });
    expect(status.vectorDocuments).toEqual({
      embeddingPending: 0,
      embeddingRunning: 0,
      indexPending: 0,
      indexRunning: 0,
      failed: 0,
    });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("sums pending/running queues for total backlog", () => {
    const status: QueueStatus = {
      ts: 1,
      batchesVlm: { pending: 1, running: 2, failed: 3 },
      screenshotsOcr: { pending: 4, running: 5, failed: 6 },
      batchesThreadLlm: { pending: 7, running: 8, failed: 9 },
      vectorDocuments: {
        embeddingPending: 10,
        embeddingRunning: 11,
        indexPending: 12,
        indexRunning: 13,
        failed: 14,
      },
      activitySummaries: { pending: 15, running: 16, failed: 17 },
      activityEventDetails: { pending: 18, running: 19, failed: 20 },
    };

    expect(inspector.getTotalPendingCountFromStatus(status)).toBe(141);
  });
});
