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
vi.mock("../../database", () => ({ getDb: mockGetDb }));
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
vi.mock("./schedulers/ocr-scheduler", () => ({ ocrScheduler: { start: vi.fn(), stop: vi.fn() } }));
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
    vi.useFakeTimers();
    mockDb = createDbMock({ selectSteps: [{ all: [] }] });
    mockGetDb.mockReturnValue(mockDb);

    module = new ScreenshotProcessingModule();
    mockScreenCapture = {
      start: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
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
});
