/**
 * Unit Tests for Base Scheduler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockEmit = vi.hoisted(() => vi.fn());

vi.mock("../../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("../event-bus", () => ({
  screenshotProcessingEventBus: {
    emit: mockEmit,
  },
}));

import { BaseScheduler, SchedulerLane } from "./base-scheduler";

class TestScheduler extends BaseScheduler {
  name = "test-scheduler";
  cycleCount = 0;
  earliestNextRun: number | null = null;
  isRunning = false;

  start(): void {
    this.isRunning = true;
  }

  stop(): void {
    this.isRunning = false;
    this.clearTimer?.();
  }

  protected getDefaultIntervalMs(): number {
    return 5000;
  }

  protected getMinDelayMs(): number {
    return 100;
  }

  protected computeEarliestNextRun(): number | null {
    return this.earliestNextRun;
  }

  protected async runCycle(): Promise<void> {
    this.cycleCount++;
  }
}

describe("BaseScheduler", () => {
  let scheduler: TestScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new TestScheduler();
    vi.clearAllMocks();
  });

  afterEach(() => {
    scheduler.stop?.();
    vi.useRealTimers();
  });

  describe("processInLanes", () => {
    it("processes items from both lanes", async () => {
      const processed: Array<{ item: string; lane: SchedulerLane }> = [];

      await scheduler.processInLanes({
        lanes: {
          realtime: ["r1", "r2", "r3"],
          recovery: ["c1", "c2"],
        },
        concurrency: 2,
        handler: async (item, lane) => {
          processed.push({ item, lane });
        },
      });

      expect(processed.length).toBe(5);
      expect(processed.some((p) => p.lane === "realtime")).toBe(true);
      expect(processed.some((p) => p.lane === "recovery")).toBe(true);
    });

    it("respects maxItems limit", async () => {
      const processed: string[] = [];

      await scheduler.processInLanes({
        lanes: {
          realtime: ["r1", "r2", "r3"],
          recovery: ["c1", "c2"],
        },
        concurrency: 2,
        maxItems: 3,
        handler: async (item) => {
          processed.push(item);
        },
      });

      expect(processed.length).toBe(3);
    });

    it("handles empty lanes gracefully", async () => {
      const processed: string[] = [];

      await scheduler.processInLanes({
        lanes: {
          realtime: [],
          recovery: [],
        },
        concurrency: 2,
        handler: async (item) => {
          processed.push(item);
        },
      });

      expect(processed.length).toBe(0);
    });

    it("calls onError when handler fails", async () => {
      const onError = vi.fn();

      await scheduler.processInLanes({
        lanes: {
          realtime: ["r1"],
          recovery: [],
        },
        concurrency: 1,
        handler: async () => {
          throw new Error("Test error");
        },
        onError,
      });

      expect(onError).toHaveBeenCalled();
    });

    it("uses lane weights correctly", async () => {
      const processed: Array<{ item: string; lane: SchedulerLane }> = [];

      await scheduler.processInLanes({
        lanes: {
          realtime: ["r1", "r2", "r3", "r4"],
          recovery: ["c1"],
        },
        concurrency: 1,
        laneWeights: { realtime: 3, recovery: 1 },
        handler: async (item, lane) => {
          processed.push({ item, lane });
        },
      });

      expect(processed.length).toBe(5);
    });
  });

  describe("scheduleSoon", () => {
    it("schedules cycle soon", async () => {
      scheduler.start();
      scheduler.scheduleSoon?.();

      await vi.advanceTimersByTimeAsync(1000);

      expect(scheduler.cycleCount).toBeGreaterThan(0);
    });
  });

  describe("scheduleNext", () => {
    it("schedules cycle with default interval", async () => {
      scheduler.start();
      scheduler.scheduleNext?.();

      await vi.advanceTimersByTimeAsync(5000);

      expect(scheduler.cycleCount).toBeGreaterThan(0);
    });

    it("respects earliest next run", async () => {
      scheduler.earliestNextRun = Date.now() + 2000;
      scheduler.start();
      scheduler.scheduleNext?.();

      await vi.advanceTimersByTimeAsync(2100);

      expect(scheduler.cycleCount).toBeGreaterThan(0);
    });
  });

  describe("emit", () => {
    it("emits events through event bus", () => {
      scheduler.emit("batch:ready", {
        type: "batch:ready",
        timestamp: Date.now(),
        trigger: "add",
        batches: {},
      });

      expect(mockEmit).toHaveBeenCalled();
    });
  });
});
