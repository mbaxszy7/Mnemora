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
  safeDeleteCaptureFile: vi.fn().mockResolvedValue(true),
}));
vi.mock("../ai-runtime-service", () => ({
  aiRuntimeService: { registerCaptureControlCallbacks: vi.fn() },
}));
vi.mock("./source-buffer-registry", () => ({
  sourceBufferRegistry: {
    initialize: vi.fn(),
    dispose: vi.fn(),
    add: vi.fn().mockResolvedValue({ accepted: true }),
    setPhashThreshold: vi.fn(),
    setPreferences: vi.fn(),
  },
}));
vi.mock("./batch-builder", () => ({
  batchBuilder: { createAndPersistBatch: vi.fn().mockResolvedValue({ batch: { batchId: "b1" } }) },
}));
vi.mock("./schedulers/batch-vlm-scheduler", () => ({
  batchVlmScheduler: { start: vi.fn(), stop: vi.fn(), wake: vi.fn() },
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

  it("updates phash threshold", async () => {
    const { sourceBufferRegistry } = await import("./source-buffer-registry");
    module.setPhashThreshold(8);
    expect(sourceBufferRegistry.setPhashThreshold).toHaveBeenCalledWith(8);
  });
});
