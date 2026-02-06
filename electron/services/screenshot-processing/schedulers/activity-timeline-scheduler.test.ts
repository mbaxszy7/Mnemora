/**
 * Unit Tests for Activity Timeline Scheduler
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
  }))
);

vi.mock("../../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("../../../database", () => ({
  getDb: mockGetDb,
}));

vi.mock("../../../database/schema", () => ({
  activitySummaries: {
    id: "id",
    windowStart: "windowStart",
    windowEnd: "windowEnd",
    status: "status",
    nextRunAt: "nextRunAt",
  },
}));

vi.mock("../../ai-runtime-service", () => ({
  aiRuntimeService: {
    acquire: vi.fn().mockResolvedValue(vi.fn()),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock("../activity-monitor-service", () => ({
  activityMonitorService: {
    generateWindowSummary: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../config", () => ({
  processingConfig: {
    scheduler: {
      scanIntervalMs: 5000,
    },
    activityTimeline: {
      intervalMs: 30000,
      minDelayMs: 100,
    },
  },
}));

import { ActivityTimelineScheduler } from "./activity-timeline-scheduler";

describe("ActivityTimelineScheduler", () => {
  let scheduler: ActivityTimelineScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new ActivityTimelineScheduler();
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
      await vi.advanceTimersByTimeAsync(30000);
      expect(scheduler["isRunning"]).toBe(true);
    });

    it("handles errors gracefully", async () => {
      mockGetDb.mockImplementation(() => {
        throw new Error("DB error");
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(30000);

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
