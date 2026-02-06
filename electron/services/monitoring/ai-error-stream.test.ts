import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  llmUsageEvents: {
    ts: "ts",
    capability: "capability",
    operation: "operation",
    model: "model",
    errorCode: "errorCode",
    status: "status",
  },
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  desc: vi.fn((value: unknown) => value),
}));

import { AIErrorStream } from "./ai-error-stream";

function resetSingleton() {
  (AIErrorStream as unknown as { instance: AIErrorStream | null }).instance = null;
}

describe("AIErrorStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetSingleton();
  });

  afterEach(() => {
    AIErrorStream.getInstance().stop();
    resetSingleton();
    vi.useRealTimers();
  });

  it("queries recent errors in chronological order", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              ts: 200,
              capability: "vlm",
              operation: "op2",
              model: "m2",
              errorCode: "e2",
            },
            {
              ts: 100,
              capability: "text",
              operation: "op1",
              model: "m1",
              errorCode: null,
            },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const stream = AIErrorStream.getInstance();
    const result = await stream.queryRecentErrors(10);

    expect(result).toEqual([
      { ts: 100, capability: "text", operation: "op1", model: "m1", errorCode: null },
      { ts: 200, capability: "vlm", operation: "op2", model: "m2", errorCode: "e2" },
    ]);
  });

  it("returns empty list when recent error query fails", async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error("db failed");
    });

    const stream = AIErrorStream.getInstance();
    await expect(stream.queryRecentErrors()).resolves.toEqual([]);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("computes error rate by capability", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            { capability: "vlm" },
            { capability: "vlm" },
            { capability: "text" },
            { capability: "embedding" },
            { capability: "unknown" },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const stream = AIErrorStream.getInstance();
    const rate = await stream.getErrorRate(60000);

    expect(rate).toEqual({ vlm: 2, text: 1, embedding: 1 });
  });

  it("returns zero rates when rate query fails", async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error("db failed");
    });

    const stream = AIErrorStream.getInstance();
    await expect(stream.getErrorRate(60000)).resolves.toEqual({ vlm: 0, text: 0, embedding: 0 });
  });

  it("returns top errors grouped by code", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            { errorCode: "timeout" },
            { errorCode: "timeout" },
            { errorCode: "schema" },
            { errorCode: null },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const stream = AIErrorStream.getInstance();
    const result = await stream.getErrorsByCode(2);

    expect(result).toEqual([
      { errorCode: "timeout", count: 2 },
      { errorCode: "schema", count: 1 },
    ]);
  });

  it("loads initial errors and polls new ones when started", async () => {
    vi.useFakeTimers();
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              ts: 110,
              capability: "vlm",
              operation: "init",
              model: "m1",
              errorCode: "e1",
            },
          ],
        },
        {
          all: [
            {
              ts: 120,
              capability: "text",
              operation: "poll",
              model: "m2",
              errorCode: "e2",
            },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const stream = AIErrorStream.getInstance();
    const onError = vi.fn();
    stream.on("error", onError);

    stream.start();
    await Promise.resolve();

    expect(stream.isRunning()).toBe(true);
    expect(stream.getRecentErrors()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ ts: 120, capability: "text", operation: "poll" })
    );
    expect(stream.getRecentErrors()).toHaveLength(2);
  });

  it("is idempotent for start and stop", async () => {
    vi.useFakeTimers();
    mockDb = createDbMock({ selectSteps: [{ all: [] }] });
    mockGetDb.mockReturnValue(mockDb);

    const stream = AIErrorStream.getInstance();
    stream.start();
    stream.start();
    expect(mockLogger.debug).toHaveBeenCalledWith("AIErrorStream already running");

    stream.stop();
    stream.stop();
    expect(stream.isRunning()).toBe(false);
  });
});
