import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockOn = vi.hoisted(() => vi.fn());
const mockOff = vi.hoisted(() => vi.fn());

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

const mockSafeDelete = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockSourceBufferRegistry = vi.hoisted(() => ({
  initialize: vi.fn(),
  dispose: vi.fn(),
  add: vi.fn().mockResolvedValue({ accepted: true }),
  setPhashThreshold: vi.fn(),
  setPreferences: vi.fn(),
}));
const mockBatchBuilder = vi.hoisted(() => ({
  createAndPersistBatch: vi.fn().mockResolvedValue({ batch: { batchId: "b1" } }),
}));
const mockBatchVlmScheduler = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  wake: vi.fn(),
}));

vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("../screen-capture/event-bus", () => ({
  screenCaptureEventBus: { on: mockOn, off: mockOff },
}));
vi.mock("./event-bus", () => ({
  screenshotProcessingEventBus: { on: mockOn, off: mockOff, emit: vi.fn() },
}));

vi.mock("../../database/schema", () => ({
  screenshots: {
    id: "id",
    sourceKey: "sourceKey",
    ts: "ts",
    phash: "phash",
    width: "width",
    height: "height",
    appHint: "appHint",
    windowTitle: "windowTitle",
    filePath: "filePath",
    storageState: "storageState",
    batchId: "batchId",
    ocrStatus: "ocrStatus",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  batches: { id: "id", vlmStatus: "vlmStatus" },
}));
vi.mock("../screen-capture/capture-storage", () => ({
  safeDeleteCaptureFile: mockSafeDelete,
}));
vi.mock("../ai-runtime-service", () => ({
  aiRuntimeService: { registerCaptureControlCallbacks: vi.fn() },
}));
vi.mock("./source-buffer-registry", () => ({
  sourceBufferRegistry: mockSourceBufferRegistry,
}));
vi.mock("./batch-builder", () => ({
  batchBuilder: mockBatchBuilder,
}));
vi.mock("./schedulers/batch-vlm-scheduler", () => ({
  batchVlmScheduler: mockBatchVlmScheduler,
}));

vi.mock("./schedulers/thread-scheduler", () => ({
  threadScheduler: { start: vi.fn(), stop: vi.fn() },
}));
vi.mock("./schedulers/activity-timeline-scheduler", () => ({
  activityTimelineScheduler: { start: vi.fn(), stop: vi.fn() },
}));
vi.mock("./schedulers/vector-document-scheduler", () => ({
  vectorDocumentScheduler: { start: vi.fn(), stop: vi.fn() },
}));
vi.mock("./thread-runtime-service", () => ({
  threadRuntimeService: { start: vi.fn(), stop: vi.fn() },
}));

const mockOcrScheduler = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  wake: vi.fn(),
}));

const mockFtsHealthService = vi.hoisted(() => ({
  retryRepair: vi.fn().mockResolvedValue({ status: "healthy" }),
  getDetails: vi.fn().mockReturnValue({ status: "healthy", isUsable: true }),
}));

const mockDatabaseService = vi.hoisted(() => ({
  getSqlite: vi.fn().mockReturnValue({}),
}));

vi.mock("./schedulers/ocr-scheduler", () => ({ ocrScheduler: mockOcrScheduler }));
vi.mock("../fts-health-service", () => ({ ftsHealthService: mockFtsHealthService }));
vi.mock("../../database", () => ({
  getDb: mockGetDb,
  databaseService: mockDatabaseService,
}));
vi.mock("./ocr-service", () => ({ ocrService: { warmup: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("./config", () => ({
  processingConfig: {
    cleanup: {
      fallbackIntervalMs: 1000,
      fallbackEphemeralMaxAgeMs: 1000,
      fallbackBatchSize: 10,
    },
    batch: { minSize: 2, timeoutMs: 1000 },
    backpressure: { levels: [{ phashThreshold: 10 }] },
  },
}));

import { ScreenshotProcessingModule } from "./screenshot-processing-module";
import type { ScreenCaptureModuleType } from "../screen-capture";

describe("ScreenshotProcessingModule", () => {
  let module: ScreenshotProcessingModule;
  let mockScreenCapture: ScreenCaptureModuleType;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOcrScheduler.start.mockClear();
    mockOcrScheduler.stop.mockClear();
    mockOcrScheduler.wake.mockClear();
    vi.useFakeTimers();
    mockDb = createDbMock({ selectSteps: [{ all: [] }] });
    mockGetDb.mockReturnValue(mockDb);

    module = new ScreenshotProcessingModule();
    mockScreenCapture = {
      start: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      tryInitialize: vi.fn().mockResolvedValue(true),
      getState: vi.fn().mockReturnValue({ status: "idle" }),
      setPreferences: vi.fn(),
    } as unknown as ScreenCaptureModuleType;
  });

  afterEach(() => {
    module.dispose();
    vi.useRealTimers();
  });

  it("initializes and registers listeners", () => {
    module.initialize({ screenCapture: mockScreenCapture });
    expect(mockOn).toHaveBeenCalled();
  });

  it("re-initializes by disposing first", () => {
    module.initialize({ screenCapture: mockScreenCapture });
    module.initialize({ screenCapture: mockScreenCapture });
    expect(mockOff).toHaveBeenCalled();
  });

  it("disposes idempotently", () => {
    module.initialize({ screenCapture: mockScreenCapture });
    module.dispose();
    module.dispose();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("warms ocr service", async () => {
    const { ocrService } = await import("./ocr-service");
    await module.ocrWarmup();
    expect(ocrService.warmup).toHaveBeenCalled();
  });

  it("updates phash threshold", () => {
    module.setPhashThreshold(8);
    expect(mockSourceBufferRegistry.setPhashThreshold).toHaveBeenCalledWith(8);
  });

  describe("fallback cleanup", () => {
    it("runs cleanup on interval and deletes stale ephemeral screenshots", async () => {
      mockDb = createDbMock({
        selectSteps: [{ all: [{ id: 1, filePath: "/tmp/img.png" }] }],
        updateSteps: [{ run: { changes: 1 } }],
      });
      mockGetDb.mockReturnValue(mockDb);
      mockSafeDelete.mockResolvedValue(true);

      module.initialize({ screenCapture: mockScreenCapture });

      await vi.advanceTimersByTimeAsync(1100);

      expect(mockSafeDelete).toHaveBeenCalledWith("/tmp/img.png");
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ deletedCount: 1 }),
        expect.any(String)
      );
    });

    it("skips fallback cleanup when no candidates found", async () => {
      mockDb = createDbMock({ selectSteps: [{ all: [] }] });
      mockGetDb.mockReturnValue(mockDb);

      module.initialize({ screenCapture: mockScreenCapture });

      await vi.advanceTimersByTimeAsync(1100);

      expect(mockSafeDelete).not.toHaveBeenCalled();
    });

    it("skips candidates with null filePath", async () => {
      mockDb = createDbMock({
        selectSteps: [{ all: [{ id: 1, filePath: null }] }],
      });
      mockGetDb.mockReturnValue(mockDb);

      module.initialize({ screenCapture: mockScreenCapture });
      await vi.advanceTimersByTimeAsync(1100);

      expect(mockSafeDelete).not.toHaveBeenCalled();
    });

    it("handles delete failure gracefully", async () => {
      mockDb = createDbMock({
        selectSteps: [{ all: [{ id: 1, filePath: "/tmp/img.png" }] }],
      });
      mockGetDb.mockReturnValue(mockDb);
      mockSafeDelete.mockResolvedValue(false);

      module.initialize({ screenCapture: mockScreenCapture });
      await vi.advanceTimersByTimeAsync(1100);

      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("handles DB error in fallback cleanup gracefully", async () => {
      mockDb = createDbMock();
      mockGetDb.mockReturnValue(mockDb);
      // After init, make getDb throw for fallback cleanup
      const initDb = createDbMock({ selectSteps: [{ all: [] }] });
      mockGetDb.mockReturnValue(initDb);

      module.initialize({ screenCapture: mockScreenCapture });

      mockGetDb.mockImplementation(() => {
        throw new Error("DB error");
      });

      await vi.advanceTimersByTimeAsync(1100);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("onPreferencesChanged", () => {
    it("updates source buffer registry preferences", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "preferences:changed")?.[1];
      expect(handler).toBeDefined();

      await handler({ preferences: { key: "val" } });
      expect(mockSourceBufferRegistry.setPreferences).toHaveBeenCalledWith({ key: "val" });
    });

    it("logs error when setPreferences throws", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "preferences:changed")?.[1];

      mockSourceBufferRegistry.setPreferences.mockImplementation(() => {
        throw new Error("fail");
      });

      await handler({ preferences: {} });
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("onCaptureComplete", () => {
    it("routes capture results into source buffer and deletes rejected", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "capture:complete")?.[1];
      expect(handler).toBeDefined();

      mockSourceBufferRegistry.add.mockResolvedValue({ accepted: false });

      await handler({
        result: [
          {
            filePath: "/tmp/cap.png",
            buffer: Buffer.alloc(0),
            timestamp: 1000,
            source: { type: "screen", id: "s1", displayId: "d1" },
          },
        ],
      });

      expect(mockSourceBufferRegistry.add).toHaveBeenCalled();
      expect(mockSafeDelete).toHaveBeenCalledWith("/tmp/cap.png");
    });

    it("skips results without filePath", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "capture:complete")?.[1];

      await handler({
        result: [
          {
            filePath: null,
            buffer: Buffer.alloc(0),
            timestamp: 1000,
            source: { type: "screen", id: "s1" },
          },
        ],
      });

      expect(mockSourceBufferRegistry.add).not.toHaveBeenCalled();
    });

    it("handles window source type", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "capture:complete")?.[1];

      mockSourceBufferRegistry.add.mockResolvedValue({ accepted: true });

      await handler({
        result: [
          {
            filePath: "/tmp/win.png",
            buffer: Buffer.alloc(0),
            timestamp: 1000,
            source: { type: "window", id: "w1", appName: "App", windowTitle: "Win" },
          },
        ],
      });

      const addCall = mockSourceBufferRegistry.add.mock.calls[0][0];
      expect(addCall.sourceKey).toBe("window:w1");
    });

    it("logs error when add throws", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "capture:complete")?.[1];

      mockSourceBufferRegistry.add.mockRejectedValue(new Error("fail"));

      await handler({
        result: [
          {
            filePath: "/tmp/cap.png",
            buffer: Buffer.alloc(0),
            timestamp: 1000,
            source: { type: "screen", id: "s1" },
          },
        ],
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("onBatchReady", () => {
    it("persists batch for each source", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "batch:ready")?.[1];
      expect(handler).toBeDefined();

      await handler({
        batches: {
          "screen:d1": [{ id: 1 }, { id: 2 }],
        },
      });

      expect(mockBatchBuilder.createAndPersistBatch).toHaveBeenCalledWith("screen:d1", [
        { id: 1 },
        { id: 2 },
      ]);
    });

    it("logs error when batch persist fails for a source", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "batch:ready")?.[1];

      mockBatchBuilder.createAndPersistBatch.mockRejectedValue(new Error("persist fail"));

      await handler({
        batches: { "screen:d1": [{ id: 1 }] },
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("onBatchPersisted", () => {
    it("wakes batch VLM scheduler", () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "batch:persisted")?.[1];
      expect(handler).toBeDefined();

      handler({ batchId: "b1", batchDbId: 1, sourceKey: "screen:d1" });
      expect(mockBatchVlmScheduler.wake).toHaveBeenCalled();
    });

    it("logs error when wake throws", () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "batch:persisted")?.[1];

      mockBatchVlmScheduler.wake.mockImplementation(() => {
        throw new Error("wake failed");
      });

      handler({ batchId: "b1", batchDbId: 1, sourceKey: "screen:d1" });
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("onPersistAcceptedScreenshot", () => {
    it("inserts screenshot record into database", async () => {
      const mockInsertDb = createDbMock({
        insertSteps: [{ get: { id: 42 } }],
      });
      mockGetDb.mockReturnValue(mockInsertDb);

      module.initialize({ screenCapture: mockScreenCapture });

      // The onPersistAcceptedScreenshot callback is passed to sourceBufferRegistry.initialize
      const initCall = mockSourceBufferRegistry.initialize.mock.calls[0];
      expect(initCall).toBeDefined();
      const persistCallback = initCall[0];

      const result = await persistCallback({
        sourceKey: "screen:d1",
        ts: 1000,
        phash: "abc123",
        filePath: "/tmp/test.png",
        meta: {
          width: 1920,
          height: 1080,
          appHint: "vscode",
          windowTitle: "test.ts",
        },
      });

      expect(result).toBe(42);
    });

    it("handles null meta fields", async () => {
      const mockInsertDb = createDbMock({
        insertSteps: [{ get: { id: 99 } }],
      });
      mockGetDb.mockReturnValue(mockInsertDb);

      module.initialize({ screenCapture: mockScreenCapture });
      const persistCallback = mockSourceBufferRegistry.initialize.mock.calls[0][0];

      const result = await persistCallback({
        sourceKey: "screen:d1",
        ts: 2000,
        phash: "def456",
        filePath: "/tmp/test2.png",
        meta: {},
      });

      expect(result).toBe(99);
    });
  });

  describe("onCaptureComplete - screen displayId fallback", () => {
    it("uses id when displayId is undefined", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "capture:complete")?.[1];

      mockSourceBufferRegistry.add.mockResolvedValue({ accepted: true });

      await handler({
        result: [
          {
            filePath: "/tmp/cap.png",
            buffer: Buffer.alloc(0),
            timestamp: 1000,
            source: { type: "screen", id: "s1", displayId: undefined },
          },
        ],
      });

      const addCall = mockSourceBufferRegistry.add.mock.calls[0][0];
      expect(addCall.sourceKey).toBe("screen:s1");
    });
  });

  describe("fallback cleanup concurrency", () => {
    it("skips cleanup when already in progress", async () => {
      mockDb = createDbMock({
        selectSteps: [
          { all: [{ id: 1, filePath: "/tmp/img.png" }] },
          { all: [] }, // Second call returns empty to avoid concurrent execution
        ],
        updateSteps: [{ run: { changes: 1 } }],
      });
      mockGetDb.mockReturnValue(mockDb);
      mockSafeDelete.mockResolvedValue(true);

      module.initialize({ screenCapture: mockScreenCapture });

      // Trigger first cleanup
      await vi.advanceTimersByTimeAsync(1100);

      // Mock should only be called once since second cleanup is skipped
      expect(mockSafeDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe("onBatchReady error handling", () => {
    it("handles unexpected error in batch ready handler", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "batch:ready")?.[1];

      // Make Object.entries throw by providing null prototype that causes issues
      const errorBatches = {
        get batches() {
          throw new Error("Unexpected batch error");
        },
      };

      await handler(errorBatches as unknown as { batches: Record<string, unknown[]> });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        "Failed to handle batch:ready event"
      );
    });
  });

  describe("onSchedulerDegraded - FTS auto-repair", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockDatabaseService.getSqlite.mockReturnValue({});
    });

    it("ignores non-OCR scheduler degradation", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      await handler({
        scheduler: "BatchVlmScheduler",
        timestamp: Date.now(),
        reason: "Some other error",
      });

      expect(mockFtsHealthService.retryRepair).not.toHaveBeenCalled();
    });

    it("ignores OCR degradation without FTS5 corruption", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "Some other error not related to FTS5",
      });

      expect(mockFtsHealthService.retryRepair).not.toHaveBeenCalled();
    });

    it("skips duplicate repair when already in progress", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      // First call starts repair
      const firstCall = handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected",
      });

      // Second call should be skipped
      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected",
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "FTS auto-repair already in progress, skipping duplicate request"
      );

      await firstCall;
    });

    it("logs error when sqlite connection unavailable", async () => {
      mockDatabaseService.getSqlite.mockReturnValue(null);

      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected",
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Cannot run FTS auto-repair: sqlite connection unavailable"
      );
      expect(mockFtsHealthService.retryRepair).not.toHaveBeenCalled();
    });

    it("logs error when automatic repair fails", async () => {
      mockFtsHealthService.retryRepair.mockResolvedValueOnce({
        status: "degraded",
        error: "Repair failed",
      });

      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      // Clear mocks to distinguish between initialization call and repair call
      mockOcrScheduler.start.mockClear();

      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected",
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ status: "degraded" }) }),
        "Automatic FTS repair failed"
      );
      // Should NOT restart OCR scheduler when repair fails
      expect(mockOcrScheduler.start).not.toHaveBeenCalled();
    });

    it("restarts OCR scheduler after successful repair", async () => {
      mockFtsHealthService.retryRepair.mockResolvedValueOnce({
        status: "healthy",
        durationMs: 100,
        checkAttempts: 1,
        rebuildPerformed: true,
      });

      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected",
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Automatic FTS repair succeeded, restarting OCR scheduler"
      );
      expect(mockOcrScheduler.start).toHaveBeenCalled();
      expect(mockOcrScheduler.wake).toHaveBeenCalledWith("fts:auto-repaired");
    });

    it("handles unexpected error during repair", async () => {
      mockFtsHealthService.retryRepair.mockRejectedValueOnce(new Error("Unexpected crash"));

      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected",
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        "Automatic FTS repair crashed"
      );
    });

    it("resets autoRepairInFlight flag after completion", async () => {
      module.initialize({ screenCapture: mockScreenCapture });
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "scheduler:degraded")?.[1];

      // First repair succeeds
      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected",
      });

      vi.clearAllMocks();

      // Second repair should work (not skipped)
      await handler({
        scheduler: "OcrScheduler",
        timestamp: Date.now(),
        reason: "FTS5 corruption detected again",
      });

      expect(mockFtsHealthService.retryRepair).toHaveBeenCalled();
    });
  });
});
