import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMock } from "../test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockEmit = vi.hoisted(() => vi.fn());

const mockGetLimit = vi.hoisted(() => vi.fn(() => 1));

const mockProcessBatch = vi.hoisted(() => vi.fn());
const mockUpsertNodeForScreenshot = vi.hoisted(() => vi.fn());
const mockSafeDeleteCaptureFile = vi.hoisted(() => vi.fn(async () => true));
const mockOcrWake = vi.hoisted(() => vi.fn());
const mockThreadWake = vi.hoisted(() => vi.fn());

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("../event-bus", () => ({ screenshotProcessingEventBus: { emit: mockEmit } }));
vi.mock("../../../database", () => ({ getDb: mockGetDb }));
vi.mock("../../../database/schema", () => ({
  batches: {
    id: "id",
    batchId: "batchId",
    sourceKey: "sourceKey",
    screenshotIds: "screenshotIds",
    tsStart: "tsStart",
    tsEnd: "tsEnd",
    vlmStatus: "vlmStatus",
    vlmAttempts: "vlmAttempts",
    vlmNextRunAt: "vlmNextRunAt",
    vlmErrorMessage: "vlmErrorMessage",
    threadLlmStatus: "threadLlmStatus",
    threadLlmAttempts: "threadLlmAttempts",
    threadLlmNextRunAt: "threadLlmNextRunAt",
    updatedAt: "updatedAt",
  },
  screenshots: {
    id: "id",
    ts: "ts",
    sourceKey: "sourceKey",
    filePath: "filePath",
    appHint: "appHint",
    windowTitle: "windowTitle",
    storageState: "storageState",
    ocrStatus: "ocrStatus",
    ocrAttempts: "ocrAttempts",
    ocrNextRunAt: "ocrNextRunAt",
    updatedAt: "updatedAt",
  },
}));

vi.mock("../config", () => ({
  processingConfig: {
    scheduler: {
      scanIntervalMs: 1000,
      staleRunningThresholdMs: 10_000,
      scanCap: 20,
      laneRecoveryAgeMs: 60_000,
    },
    retry: {
      maxAttempts: 3,
      delayMs: 2500,
    },
    ocr: {
      supportedLanguages: ["en", "zh"],
    },
  },
}));

vi.mock("../vlm-processor", () => ({ vlmProcessor: { processBatch: mockProcessBatch } }));
vi.mock("../context-node-service", () => ({
  contextNodeService: { upsertNodeForScreenshot: mockUpsertNodeForScreenshot },
}));
vi.mock("../../screen-capture/capture-storage", () => ({
  safeDeleteCaptureFile: mockSafeDeleteCaptureFile,
}));
vi.mock("./ocr-scheduler", () => ({ ocrScheduler: { wake: mockOcrWake } }));
vi.mock("./thread-scheduler", () => ({ threadScheduler: { wake: mockThreadWake } }));
vi.mock("../../ai-runtime-service", () => ({ aiRuntimeService: { getLimit: mockGetLimit } }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    eq: vi.fn(() => ({})),
    and: vi.fn(() => ({})),
    lt: vi.fn(() => ({})),
    or: vi.fn(() => ({})),
    isNull: vi.fn(() => ({})),
    lte: vi.fn(() => ({})),
    asc: vi.fn(() => ({})),
    desc: vi.fn(() => ({})),
    inArray: vi.fn(() => ({})),
    gte: vi.fn(() => ({})),
  };
});

import { BatchVlmScheduler, __test__ } from "./batch-vlm-scheduler";
import type { VLMContextNode } from "../schemas";
import type { PendingBatchRecord } from "../types";

type LaneSplitResult = {
  realtime: PendingBatchRecord[];
  recovery: PendingBatchRecord[];
};

type UpdateSetPayload = Record<string, unknown>;

type UpdateResultValue = {
  set?: {
    mock?: {
      calls?: unknown[][];
    };
  };
};

function extractUpdatePayloads(results: Array<{ value: unknown }>): UpdateSetPayload[] {
  return results
    .map((result) => {
      const value = result.value as UpdateResultValue;
      const firstCallArgs = value.set?.mock?.calls?.[0];
      return (firstCallArgs?.[0] as UpdateSetPayload | undefined) ?? undefined;
    })
    .filter((payload): payload is UpdateSetPayload => payload !== undefined);
}

describe("BatchVlmScheduler", () => {
  let scheduler: BatchVlmScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.clearAllMocks();

    mockDb = createDbMock();
    mockGetDb.mockReturnValue(mockDb);
    scheduler = new BatchVlmScheduler();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("parseScreenshotIds", () => {
    it("returns parsed ids", () => {
      const result = __test__.parseScreenshotIds("[1,2,3]", 12);
      expect(result).toEqual([1, 2, 3]);
    });

    it("filters non-numeric values", () => {
      const result = __test__.parseScreenshotIds('[1,"bad",2]', 12);
      expect(result).toEqual([1, 2]);
    });

    it("returns empty array on invalid json", () => {
      const result = __test__.parseScreenshotIds("not-json", 12);
      expect(result).toEqual([]);
    });
  });

  it("computes earliest run time", () => {
    mockDb = createDbMock({ selectSteps: [{ get: { nextRunAt: 123 } }] });
    mockGetDb.mockReturnValue(mockDb);
    const t1 = (
      scheduler as unknown as { computeEarliestNextRun: () => number | null }
    ).computeEarliestNextRun();
    expect(t1).toBe(123);

    mockDb = createDbMock({ selectSteps: [{ get: undefined }] });
    mockGetDb.mockReturnValue(mockDb);
    const t2 = (
      scheduler as unknown as { computeEarliestNextRun: () => number | null }
    ).computeEarliestNextRun();
    expect(t2).toBeNull();

    mockDb = createDbMock({ selectSteps: [{ get: { nextRunAt: null } }] });
    mockGetDb.mockReturnValue(mockDb);
    const t3 = (
      scheduler as unknown as { computeEarliestNextRun: () => number | null }
    ).computeEarliestNextRun();
    expect(t3).toBe(10_000);
  });

  it("scans pending records, filters invalid screenshotIds, and merges newest+oldest", async () => {
    const now = Date.now();
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              id: 1,
              batchId: "b1",
              sourceKey: "screen:0",
              screenshotIds: "[1,2,3]",
              tsStart: 1,
              tsEnd: 2,
              vlmAttempts: 0,
              updatedAt: now - 1000,
            },
            {
              id: 2,
              batchId: "b2",
              sourceKey: "screen:0",
              screenshotIds: "not-json",
              tsStart: 1,
              tsEnd: 2,
              vlmAttempts: 0,
              updatedAt: now - 2000,
            },
          ],
        },
        {
          all: [
            // duplicate of id=1 should be merged
            {
              id: 1,
              batchId: "b1",
              sourceKey: "screen:0",
              screenshotIds: "[9]",
              tsStart: 1,
              tsEnd: 2,
              vlmAttempts: 0,
              updatedAt: now - 3000,
            },
            {
              id: 3,
              batchId: "b3",
              sourceKey: "screen:0",
              screenshotIds: '[4,"bad",5]',
              tsStart: 1,
              tsEnd: 2,
              vlmAttempts: 1,
              updatedAt: now - 4000,
            },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const records = await (
      scheduler as unknown as { scanPendingRecords: () => Promise<unknown[]> }
    ).scanPendingRecords();

    expect(records).toEqual(
      expect.arrayContaining([
        // Newest+oldest are merged by id; later entries win.
        expect.objectContaining({ id: 1, screenshotIds: [9] }),
        expect.objectContaining({ id: 3, screenshotIds: [4, 5] }),
      ])
    );

    // id=2 has invalid JSON screenshotIds -> filtered out
    expect(records.some((record) => (record as { id?: number }).id === 2)).toBe(false);
  });

  it("splits records into realtime/recovery lanes", () => {
    const now = Date.now();
    const records: PendingBatchRecord[] = [
      {
        id: 1,
        batchId: "b1",
        sourceKey: "screen:0",
        screenshotIds: [1],
        tsStart: 0,
        tsEnd: 0,
        vlmAttempts: 0,
        updatedAt: now - 1000,
      },
      {
        id: 2,
        batchId: "b2",
        sourceKey: "screen:0",
        screenshotIds: [2],
        tsStart: 0,
        tsEnd: 0,
        vlmAttempts: 0,
        updatedAt: now - 100_000,
      },
    ];

    const lanes = (
      scheduler as unknown as { splitByLane: (r: PendingBatchRecord[]) => LaneSplitResult }
    ).splitByLane(records);

    expect(lanes.realtime.map((r: PendingBatchRecord) => r.id)).toEqual([1]);
    expect(lanes.recovery.map((r: PendingBatchRecord) => r.id)).toEqual([2]);
  });

  it("returns early when claim fails (changes=0)", async () => {
    mockDb = createDbMock({ updateSteps: [{ run: { changes: 0 } }] });
    mockGetDb.mockReturnValue(mockDb);

    const record: PendingBatchRecord = {
      id: 1,
      batchId: "b1",
      sourceKey: "screen:0",
      screenshotIds: [1],
      tsStart: 0,
      tsEnd: 0,
      vlmAttempts: 0,
      updatedAt: Date.now(),
    };

    await (
      scheduler as unknown as { processOneBatch: (r: PendingBatchRecord) => Promise<void> }
    ).processOneBatch(record);

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("fails batch when no screenshots are found", async () => {
    mockDb = createDbMock({
      updateSteps: [{ run: { changes: 1 } }, { run: { changes: 1 } }],
      selectSteps: [{ all: [] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const record: PendingBatchRecord = {
      id: 1,
      batchId: "b1",
      sourceKey: "screen:0",
      screenshotIds: [1],
      tsStart: 0,
      tsEnd: 0,
      vlmAttempts: 0,
      updatedAt: Date.now(),
    };

    await (
      scheduler as unknown as { processOneBatch: (r: PendingBatchRecord) => Promise<void> }
    ).processOneBatch(record);

    expect(mockEmit).toHaveBeenCalledWith(
      "batch:vlm:failed",
      expect.objectContaining({ batchId: 1, permanent: false })
    );

    const payloads = extractUpdatePayloads(mockDb.update.mock.results);
    expect(payloads.some((payload) => payload["vlmStatus"] === "failed")).toBe(true);
  });

  it("processes batch, queues OCR, and marks succeeded", async () => {
    const screenshotRow = {
      id: 1,
      ts: 9000,
      sourceKey: "screen:0",
      filePath: "/tmp/s1.png",
      appHint: null,
      windowTitle: null,
      storageState: "created",
      ocrAttempts: 0,
      ocrNextRunAt: null,
    };

    const node: VLMContextNode = {
      screenshotIndex: 1,
      title: "T",
      summary: "S",
      appContext: {
        appHint: "vscode",
        windowTitle: "win",
        sourceKey: "screen:0",
        projectName: null,
        projectKey: null,
      },
      knowledge: {
        contentType: "general",
        sourceUrl: undefined,
        projectOrLibrary: undefined,
        keyInsights: [],
        language: "en",
        textRegion: undefined,
      },
      stateSnapshot: null,
      entities: [],
      actionItems: null,
      uiTextSnippets: [],
      keywords: [],
      importance: 5,
      confidence: 8,
    };

    mockProcessBatch.mockResolvedValueOnce([node]);

    mockDb = createDbMock({
      updateSteps: [{ run: { changes: 1 } }, { run: { changes: 1 } }, { run: { changes: 1 } }],
      selectSteps: [{ all: [screenshotRow] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const record: PendingBatchRecord = {
      id: 1,
      batchId: "b1",
      sourceKey: "screen:0",
      screenshotIds: [1],
      tsStart: 0,
      tsEnd: 0,
      vlmAttempts: 0,
      updatedAt: Date.now(),
    };

    await (
      scheduler as unknown as { processOneBatch: (r: PendingBatchRecord) => Promise<void> }
    ).processOneBatch(record);

    expect(mockUpsertNodeForScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotId: 1, title: "T" })
    );

    expect(mockEmit).toHaveBeenCalledWith(
      "screenshot:ocr:queued",
      expect.objectContaining({ screenshotIds: [1] })
    );
    expect(mockOcrWake).toHaveBeenCalledWith("vlm:ocr_pending");
    expect(mockThreadWake).toHaveBeenCalledWith("vlm:succeeded");

    // Needs OCR => should not delete capture file yet.
    expect(mockSafeDeleteCaptureFile).not.toHaveBeenCalled();

    expect(mockEmit).toHaveBeenCalledWith(
      "batch:vlm:succeeded",
      expect.objectContaining({ batchId: 1 })
    );

    const payloads = extractUpdatePayloads(mockDb.update.mock.results);
    expect(
      payloads.some(
        (payload) =>
          payload["threadLlmStatus"] === "pending" && payload["vlmStatus"] === "succeeded"
      )
    ).toBe(true);
  });

  it("deletes capture file when OCR is not needed", async () => {
    mockSafeDeleteCaptureFile.mockResolvedValueOnce(true);

    const screenshotRow = {
      id: 1,
      ts: 9000,
      sourceKey: "screen:0",
      filePath: "/tmp/s1.png",
      appHint: null,
      windowTitle: null,
      storageState: "created",
      ocrAttempts: 2,
      ocrNextRunAt: 123,
    };

    const node: VLMContextNode = {
      screenshotIndex: 1,
      title: "T",
      summary: "S",
      appContext: {
        appHint: null,
        windowTitle: null,
        sourceKey: "screen:0",
        projectName: null,
        projectKey: null,
      },
      knowledge: null,
      stateSnapshot: null,
      entities: [],
      actionItems: null,
      uiTextSnippets: [],
      keywords: [],
      importance: 5,
      confidence: 8,
    };

    mockProcessBatch.mockResolvedValueOnce([node]);

    mockDb = createDbMock({
      updateSteps: [
        { run: { changes: 1 } }, // claim
        { run: { changes: 1 } }, // screenshot update
        { run: { changes: 1 } }, // storageState deleted
        { run: { changes: 1 } }, // batch succeeded
      ],
      selectSteps: [{ all: [screenshotRow] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const record: PendingBatchRecord = {
      id: 1,
      batchId: "b1",
      sourceKey: "screen:0",
      screenshotIds: [1],
      tsStart: 0,
      tsEnd: 0,
      vlmAttempts: 0,
      updatedAt: Date.now(),
    };

    await (
      scheduler as unknown as { processOneBatch: (r: PendingBatchRecord) => Promise<void> }
    ).processOneBatch(record);

    expect(mockSafeDeleteCaptureFile).toHaveBeenCalledWith("/tmp/s1.png");
    expect(mockOcrWake).not.toHaveBeenCalled();
    expect(mockEmit.mock.calls.some(([eventName]) => eventName === "screenshot:ocr:queued")).toBe(
      false
    );

    const payloads = extractUpdatePayloads(mockDb.update.mock.results);
    expect(payloads.some((payload) => payload["storageState"] === "deleted")).toBe(true);
  });

  it("warns and skips nodes when screenshotIndex is missing", async () => {
    const screenshotRow = {
      id: 1,
      ts: 9000,
      sourceKey: "screen:0",
      filePath: "/tmp/s1.png",
      appHint: null,
      windowTitle: null,
      storageState: "created",
      ocrAttempts: 0,
      ocrNextRunAt: null,
    };

    const node: VLMContextNode = {
      screenshotIndex: 2,
      title: "T",
      summary: "S",
      appContext: {
        appHint: null,
        windowTitle: null,
        sourceKey: "screen:0",
        projectName: null,
        projectKey: null,
      },
      knowledge: null,
      stateSnapshot: null,
      entities: [],
      actionItems: null,
      uiTextSnippets: [],
      keywords: [],
      importance: 5,
      confidence: 8,
    };

    mockProcessBatch.mockResolvedValueOnce([node]);

    mockDb = createDbMock({
      updateSteps: [{ run: { changes: 1 } }, { run: { changes: 1 } }],
      selectSteps: [{ all: [screenshotRow] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const record: PendingBatchRecord = {
      id: 1,
      batchId: "b1",
      sourceKey: "screen:0",
      screenshotIds: [1],
      tsStart: 0,
      tsEnd: 0,
      vlmAttempts: 0,
      updatedAt: Date.now(),
    };

    await (
      scheduler as unknown as { processOneBatch: (r: PendingBatchRecord) => Promise<void> }
    ).processOneBatch(record);

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockUpsertNodeForScreenshot).not.toHaveBeenCalled();
    expect(mockThreadWake).toHaveBeenCalledWith("vlm:succeeded");
  });

  it("marks failed_permanent when max attempts is exceeded", async () => {
    mockProcessBatch.mockRejectedValueOnce(new Error("boom"));

    const screenshotRow = {
      id: 1,
      ts: 9000,
      sourceKey: "screen:0",
      filePath: "/tmp/s1.png",
      appHint: null,
      windowTitle: null,
      storageState: "created",
      ocrAttempts: 0,
      ocrNextRunAt: null,
    };

    mockDb = createDbMock({
      updateSteps: [{ run: { changes: 1 } }, { run: { changes: 1 } }],
      selectSteps: [{ all: [screenshotRow] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const record: PendingBatchRecord = {
      id: 1,
      batchId: "b1",
      sourceKey: "screen:0",
      screenshotIds: [1],
      tsStart: 0,
      tsEnd: 0,
      vlmAttempts: 2,
      updatedAt: Date.now(),
    };

    await (
      scheduler as unknown as { processOneBatch: (r: PendingBatchRecord) => Promise<void> }
    ).processOneBatch(record);

    const payloads = extractUpdatePayloads(mockDb.update.mock.results);
    expect(payloads.some((payload) => payload["vlmStatus"] === "failed_permanent")).toBe(true);
    expect(payloads.some((payload) => payload["threadLlmStatus"] === "failed_permanent")).toBe(
      true
    );
  });
});
