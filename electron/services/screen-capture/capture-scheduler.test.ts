import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScreenCaptureScheduler, calculateNextDelay } from "./capture-scheduler";
import type { SchedulerStateEvent, CaptureStartEvent } from "./types";

describe("ScreenCaptureScheduler Unit Tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("calculateNextDelay", () => {
    it("returns interval minus execution time when result is above minDelay", () => {
      expect(calculateNextDelay(100, 15000, 100)).toBe(14900);
    });

    it("returns minDelay when execution time exceeds interval", () => {
      expect(calculateNextDelay(20000, 15000, 100)).toBe(100);
    });

    it("returns minDelay when execution time equals interval", () => {
      expect(calculateNextDelay(15000, 15000, 100)).toBe(100);
    });
  });

  describe("State Machine Transitions", () => {
    it("starts in idle state", () => {
      const scheduler = new ScreenCaptureScheduler();
      expect(scheduler.getState().status).toBe("idle");
      scheduler.stop();
    });

    it("transitions from idle to running on start()", () => {
      const scheduler = new ScreenCaptureScheduler();
      const stateEvents: SchedulerStateEvent[] = [];

      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.start();

      expect(scheduler.getState().status).toBe("running");
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].previousState).toBe("idle");
      expect(stateEvents[0].currentState).toBe("running");

      scheduler.stop();
    });

    it("transitions from running to paused on pause()", () => {
      const scheduler = new ScreenCaptureScheduler();
      const stateEvents: SchedulerStateEvent[] = [];

      scheduler.start();

      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.pause();

      expect(scheduler.getState().status).toBe("paused");
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].previousState).toBe("running");
      expect(stateEvents[0].currentState).toBe("paused");

      scheduler.stop();
    });

    it("transitions from paused to running on resume()", () => {
      const scheduler = new ScreenCaptureScheduler();
      scheduler.start();
      scheduler.pause();

      const stateEvents: SchedulerStateEvent[] = [];
      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.resume();

      expect(scheduler.getState().status).toBe("running");
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].previousState).toBe("paused");
      expect(stateEvents[0].currentState).toBe("running");

      scheduler.stop();
    });

    it("transitions to stopped on stop()", () => {
      const scheduler = new ScreenCaptureScheduler();
      scheduler.start();

      const stateEvents: SchedulerStateEvent[] = [];
      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.stop();

      expect(scheduler.getState().status).toBe("stopped");
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].previousState).toBe("running");
      expect(stateEvents[0].currentState).toBe("stopped");
    });

    it("completes full state cycle: idle -> running -> paused -> running -> stopped", () => {
      const scheduler = new ScreenCaptureScheduler();
      const stateEvents: SchedulerStateEvent[] = [];

      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      expect(scheduler.getState().status).toBe("idle");

      scheduler.start();
      expect(scheduler.getState().status).toBe("running");

      scheduler.pause();
      expect(scheduler.getState().status).toBe("paused");

      scheduler.resume();
      expect(scheduler.getState().status).toBe("running");

      scheduler.stop();
      expect(scheduler.getState().status).toBe("stopped");

      expect(stateEvents).toHaveLength(4);
      expect(stateEvents.map((e) => e.currentState)).toEqual([
        "running",
        "paused",
        "running",
        "stopped",
      ]);
    });
  });

  describe("Timer Management", () => {
    it("stop() cancels pending timers", () => {
      const captureTask = vi.fn().mockResolvedValue({
        buffer: Buffer.from([]),
        timestamp: Date.now(),
        source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
        screenId: "0",
      });

      const scheduler = new ScreenCaptureScheduler({ interval: 15000, minDelay: 100 }, captureTask);

      scheduler.start();

      // Advance time partially (not enough to trigger capture)
      vi.advanceTimersByTime(5000);

      // Stop should cancel the pending timer
      scheduler.stop();

      // Advance time past when capture would have occurred
      vi.advanceTimersByTime(20000);

      // Capture task should not have been called
      expect(captureTask).not.toHaveBeenCalled();
    });

    it("pause() cancels pending timers", () => {
      const captureTask = vi.fn().mockResolvedValue({
        buffer: Buffer.from([]),
        timestamp: Date.now(),
        source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
        screenId: "0",
      });

      const scheduler = new ScreenCaptureScheduler({ interval: 15000, minDelay: 100 }, captureTask);

      scheduler.start();

      // Advance time partially
      vi.advanceTimersByTime(5000);

      // Pause should cancel the pending timer
      scheduler.pause();

      // Advance time past when capture would have occurred
      vi.advanceTimersByTime(20000);

      // Capture task should not have been called
      expect(captureTask).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it("sets nextCaptureTime when scheduling", () => {
      const scheduler = new ScreenCaptureScheduler({ interval: 15000 });

      expect(scheduler.getState().nextCaptureTime).toBeNull();

      scheduler.start();

      expect(scheduler.getState().nextCaptureTime).not.toBeNull();
      expect(scheduler.getState().nextCaptureTime).toBeGreaterThan(Date.now() - 1000);

      scheduler.stop();
    });

    it("clears nextCaptureTime on stop", () => {
      const scheduler = new ScreenCaptureScheduler({ interval: 15000 });

      scheduler.start();
      expect(scheduler.getState().nextCaptureTime).not.toBeNull();

      scheduler.stop();
      expect(scheduler.getState().nextCaptureTime).toBeNull();
    });
  });

  describe("Runtime Configuration Update", () => {
    it("updateConfig can be called without error", () => {
      const scheduler = new ScreenCaptureScheduler({ interval: 15000 });

      // Just verify updateConfig doesn't throw
      expect(() => scheduler.updateConfig({ interval: 30000 })).not.toThrow();

      scheduler.stop();
    });
  });

  describe("Edge Cases", () => {
    it("ignores start() when already running", () => {
      const scheduler = new ScreenCaptureScheduler();
      const stateEvents: SchedulerStateEvent[] = [];

      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.start();
      scheduler.start(); // Should be ignored

      expect(stateEvents).toHaveLength(1);
      expect(scheduler.getState().status).toBe("running");

      scheduler.stop();
    });

    it("ignores stop() when already stopped", () => {
      const scheduler = new ScreenCaptureScheduler();
      const stateEvents: SchedulerStateEvent[] = [];

      scheduler.start();
      scheduler.stop();

      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.stop(); // Should be ignored

      expect(stateEvents).toHaveLength(0);
    });

    it("ignores pause() when not running", () => {
      const scheduler = new ScreenCaptureScheduler();
      const stateEvents: SchedulerStateEvent[] = [];

      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.pause(); // Should be ignored (idle state)

      expect(stateEvents).toHaveLength(0);
      expect(scheduler.getState().status).toBe("idle");

      scheduler.stop();
    });

    it("ignores resume() when not paused", () => {
      const scheduler = new ScreenCaptureScheduler();
      const stateEvents: SchedulerStateEvent[] = [];

      scheduler.start();

      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.resume(); // Should be ignored (running state)

      expect(stateEvents).toHaveLength(0);
      expect(scheduler.getState().status).toBe("running");

      scheduler.stop();
    });

    it("can restart a stopped scheduler (for hot reload support)", () => {
      const scheduler = new ScreenCaptureScheduler();

      scheduler.start();
      scheduler.stop();
      expect(scheduler.getState().status).toBe("stopped");

      const stateEvents: SchedulerStateEvent[] = [];
      scheduler.on<SchedulerStateEvent>("scheduler:state", (event) => {
        stateEvents.push(event);
      });

      scheduler.start(); // Should restart from stopped state

      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].previousState).toBe("idle"); // Reset to idle first
      expect(stateEvents[0].currentState).toBe("running");
      expect(scheduler.getState().status).toBe("running");

      scheduler.stop();
    });

    it("autoStart option starts scheduler immediately", () => {
      const scheduler = new ScreenCaptureScheduler({ autoStart: true });

      expect(scheduler.getState().status).toBe("running");

      scheduler.stop();
    });
  });

  describe("Capture Execution", () => {
    it("executes capture task at configured interval", async () => {
      vi.useRealTimers();

      const captureTask = vi.fn().mockResolvedValue({
        buffer: Buffer.from([]),
        timestamp: Date.now(),
        source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
        screenId: "0",
      });

      const scheduler = new ScreenCaptureScheduler({ interval: 30, minDelay: 10 }, captureTask);

      scheduler.start();

      // Wait for at least 2 captures
      await new Promise((resolve) => setTimeout(resolve, 100));

      scheduler.stop();

      expect(captureTask).toHaveBeenCalled();
      expect(captureTask.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("emits capture:start before executing task", async () => {
      vi.useRealTimers();

      const events: string[] = [];

      const captureTask = vi.fn().mockImplementation(async () => {
        events.push("task");
        return {
          buffer: Buffer.from([]),
          timestamp: Date.now(),
          source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
          screenId: "0",
        };
      });

      const scheduler = new ScreenCaptureScheduler({ interval: 30, minDelay: 10 }, captureTask);

      scheduler.on<CaptureStartEvent>("capture:start", () => {
        events.push("start");
      });

      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 50));

      scheduler.stop();

      // Verify start event comes before task execution
      const startIndex = events.indexOf("start");
      const taskIndex = events.indexOf("task");

      expect(startIndex).toBeLessThan(taskIndex);
    });

    it("increments captureCount on successful capture", async () => {
      vi.useRealTimers();

      const scheduler = new ScreenCaptureScheduler({ interval: 20, minDelay: 5 }, async () => ({
        buffer: Buffer.from([]),
        timestamp: Date.now(),
        source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
        screenId: "0",
      }));

      expect(scheduler.getState().captureCount).toBe(0);

      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 60));

      scheduler.stop();

      expect(scheduler.getState().captureCount).toBeGreaterThanOrEqual(2);
    });

    it("updates lastCaptureTime after capture", async () => {
      vi.useRealTimers();

      const scheduler = new ScreenCaptureScheduler({ interval: 20, minDelay: 5 }, async () => ({
        buffer: Buffer.from([]),
        timestamp: Date.now(),
        source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
        screenId: "0",
      }));

      expect(scheduler.getState().lastCaptureTime).toBeNull();

      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 40));

      scheduler.stop();

      expect(scheduler.getState().lastCaptureTime).not.toBeNull();
    });
  });
});
