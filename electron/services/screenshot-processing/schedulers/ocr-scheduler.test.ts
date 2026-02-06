import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmit = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

type DbState = {
  earliestRow: { nextRunAt: number | null } | undefined;
  linkRow: { nodeId: number } | undefined;
  nodeRow: { knowledge: string | null } | undefined;
  updates: Array<Record<string, unknown>>;
};

let dbState: DbState = {
  earliestRow: undefined,
  linkRow: undefined,
  nodeRow: undefined,
  updates: [],
};

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              get: vi.fn(() => dbState.earliestRow),
            })),
          })),
          get: vi.fn(() => {
            if (dbState.linkRow !== undefined) {
              const row = dbState.linkRow;
              dbState.linkRow = undefined;
              return row;
            }
            return dbState.nodeRow;
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          run: vi.fn(() => {
            dbState.updates.push(payload);
            return { changes: 1 };
          }),
        })),
      })),
    })),
  };
}

const mockGetDb = vi.hoisted(() => vi.fn(() => createDb()));

vi.mock("../../../database", () => ({
  getDb: mockGetDb,
}));

vi.mock("../../../database/schema", () => ({
  screenshots: {
    id: "id",
    ocrNextRunAt: "ocrNextRunAt",
    ocrStatus: "ocrStatus",
    ocrAttempts: "ocrAttempts",
    filePath: "filePath",
    storageState: "storageState",
    updatedAt: "updatedAt",
  },
  contextScreenshotLinks: {
    screenshotId: "screenshotId",
    nodeId: "nodeId",
  },
  contextNodes: {
    id: "id",
    knowledge: "knowledge",
  },
}));

vi.mock("../../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("../event-bus", () => ({
  screenshotProcessingEventBus: {
    emit: mockEmit,
  },
}));

vi.mock("../config", () => ({
  processingConfig: {
    scheduler: {
      scanIntervalMs: 1000,
      staleRunningThresholdMs: 1000,
      scanCap: 20,
      laneRecoveryAgeMs: 1000,
    },
    retry: {
      maxAttempts: 3,
      delayMs: 100,
    },
    ocr: {
      concurrency: 1,
    },
  },
}));

vi.mock("../../screen-capture/capture-storage", () => ({
  safeDeleteCaptureFile: vi.fn(async () => true),
}));

vi.mock("../ocr-service", () => ({
  ocrService: {
    recognize: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  lt: vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  ne: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
}));

import { OcrScheduler } from "./ocr-scheduler";

describe("OcrScheduler", () => {
  let scheduler: OcrScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    dbState = {
      earliestRow: undefined,
      linkRow: undefined,
      nodeRow: undefined,
      updates: [],
    };
    scheduler = new OcrScheduler();
  });

  it("starts, wakes and stops", () => {
    scheduler.start();
    scheduler.wake("manual");
    scheduler.stop();

    expect(mockLogger.info).toHaveBeenCalledWith("OCR scheduler started");
    expect(mockLogger.info).toHaveBeenCalledWith("OCR scheduler stopped");
  });

  it("computes earliest run time", () => {
    dbState.earliestRow = { nextRunAt: 123 };
    const t1 = (
      scheduler as unknown as { computeEarliestNextRun: () => number | null }
    ).computeEarliestNextRun();
    expect(t1).toBe(123);

    dbState.earliestRow = undefined;
    const t2 = (
      scheduler as unknown as { computeEarliestNextRun: () => number | null }
    ).computeEarliestNextRun();
    expect(t2).toBeNull();
  });

  it("fails screenshot and sets permanent status on max attempts", async () => {
    await (
      scheduler as unknown as {
        failScreenshot: (id: number, attempts: number, message: string) => Promise<void>;
      }
    ).failScreenshot(9, 3, "oops");

    expect(dbState.updates.at(-1)?.ocrStatus).toBe("failed_permanent");
    expect(mockEmit).toHaveBeenCalled();
  });

  it("loads text region and handles parse errors", () => {
    dbState.linkRow = { nodeId: 1 };
    dbState.nodeRow = { knowledge: "{bad-json}" };

    const region = (
      scheduler as unknown as { loadTextRegion: (id: number) => unknown }
    ).loadTextRegion(1);

    expect(region).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
