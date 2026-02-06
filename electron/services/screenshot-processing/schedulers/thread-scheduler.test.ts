/**
 * Unit Tests for Thread Scheduler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockGetDb = vi.hoisted(() =>
  vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              all: vi.fn(() => []),
              get: vi.fn(() => undefined),
            })),
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
  }))
);

vi.mock("../../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("../../../database", () => ({
  getDb: mockGetDb,
}));

vi.mock("../../../database/schema", () => ({
  contextNodes: {
    id: "id",
    threadId: "threadId",
  },
  threads: {
    id: "id",
    status: "status",
  },
  vectorDocuments: {
    id: "id",
    docType: "docType",
  },
}));

vi.mock("../../ai-runtime-service", () => ({
  aiRuntimeService: {
    acquire: vi.fn().mockResolvedValue(vi.fn()),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock("../thread-llm-service", () => ({
  threadLLMService: {
    generateThreadSummary: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock("../config", () => ({
  processingConfig: {
    scheduler: {
      scanIntervalMs: 5000,
    },
    threadScheduler: {
      intervalMs: 5000,
      minDelayMs: 100,
      maxConcurrency: 2,
    },
  },
}));

import { ThreadScheduler } from "./thread-scheduler";

describe("ThreadScheduler", () => {
  let scheduler: ThreadScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new ThreadScheduler();
    vi.clearAllMocks();
  });

  afterEach(() => {
    scheduler?.stop?.();
    vi.useRealTimers();
  });

  describe("start/stop", () => {
    it("starts the scheduler", () => {
      scheduler.start();
      expect(scheduler["isRunning"]).toBe(true);
    });

    it("stops the scheduler", () => {
      scheduler.start();
      scheduler.stop();
      expect(scheduler["isRunning"]).toBe(false);
    });

    it("is idempotent", () => {
      scheduler.start();
      scheduler.start();
      scheduler.stop();
      scheduler.stop();
      expect(scheduler["isRunning"]).toBe(false);
    });
  });

  describe("runCycle", () => {
    it("processes without errors", async () => {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(scheduler["isRunning"]).toBe(true);
    });

    it("handles errors gracefully", async () => {
      mockGetDb.mockImplementation(() => {
        throw new Error("DB error");
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("wake", () => {
    it("wakes the scheduler when running", () => {
      scheduler.start();
      scheduler.wake("test");
      expect(scheduler["isRunning"]).toBe(true);
    });
  });
});
