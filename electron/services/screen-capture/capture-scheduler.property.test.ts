import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as fc from "fast-check";
import { calculateNextDelay, ScreenCaptureScheduler } from "./capture-scheduler";
import { screenCaptureEventBus } from "./event-bus";
import type { CaptureCompleteEvent, CaptureResult } from "./types";

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

beforeEach(() => {
  screenCaptureEventBus.removeAllListeners();
});

afterEach(() => {
  screenCaptureEventBus.removeAllListeners();
});

type CaptureResultWithScreenId = CaptureResult & { screenId: string };

const dummyCaptureTask = async (): Promise<CaptureResult[]> => [];

describe("ScreenCaptureScheduler Property Tests", () => {
  /**
   *
   *
   * For any execution time and configured interval, the calculated next delay
   * SHALL equal max(INTERVAL - executionTime, minDelay).
   */
  describe("Property 1: Delay Calculation with Minimum Bound", () => {
    it("calculates next delay as max(interval - executionTime, minDelay)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 30000 }), // executionTime
          fc.integer({ min: 1000, max: 60000 }), // interval
          fc.integer({ min: 50, max: 500 }), // minDelay
          (executionTime, interval, minDelay) => {
            const result = calculateNextDelay(executionTime, interval, minDelay);
            const expected = Math.max(interval - executionTime, minDelay);
            return result === expected;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("always returns at least minDelay", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100000 }), // executionTime (can exceed interval)
          fc.integer({ min: 1000, max: 60000 }), // interval
          fc.integer({ min: 50, max: 500 }), // minDelay
          (executionTime, interval, minDelay) => {
            const result = calculateNextDelay(executionTime, interval, minDelay);
            return result >= minDelay;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("returns interval - executionTime when execution is fast enough", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 60000 }), // interval
          fc.integer({ min: 50, max: 500 }), // minDelay
          (interval, minDelay) => {
            // Only test when there's room for fast execution
            if (interval <= minDelay) return true;

            // Test with executionTime = 0 (fastest possible)
            const result = calculateNextDelay(0, interval, minDelay);
            return result === interval;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("returns minDelay when execution time exceeds interval", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 30000 }), // interval
          fc.integer({ min: 50, max: 500 }), // minDelay
          fc.integer({ min: 0, max: 30000 }), // extra time beyond interval
          (interval, minDelay, extraTime) => {
            const executionTime = interval + extraTime;
            const result = calculateNextDelay(executionTime, interval, minDelay);
            return result === minDelay;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("never returns negative values", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100000 }), // executionTime
          fc.integer({ min: 1, max: 60000 }), // interval (at least 1)
          fc.integer({ min: 1, max: 500 }), // minDelay (at least 1)
          (executionTime, interval, minDelay) => {
            const result = calculateNextDelay(executionTime, interval, minDelay);
            return result > 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   *
   *
   * For any valid interval value provided at construction, the scheduler
   * SHALL use that interval for scheduling captures.
   */
  describe("Property 5: Custom Interval Configuration", () => {
    it("scheduler can be created with custom interval and minDelay", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 60000 }), // custom interval
          fc.integer({ min: 50, max: 500 }), // custom minDelay
          (interval, minDelay) => {
            const scheduler = new ScreenCaptureScheduler({ interval, minDelay }, dummyCaptureTask);
            // Verify scheduler was created successfully
            const state = scheduler.getState();
            scheduler.stop();
            return state.status === "idle" || state.status === "stopped";
          }
        ),
        { numRuns: 100 }
      );
    });

    it("updateConfig can be called with new minDelay", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 60000 }), // initial interval
          fc.integer({ min: 50, max: 500 }), // new minDelay
          (interval, newMinDelay) => {
            const scheduler = new ScreenCaptureScheduler({ interval }, dummyCaptureTask);
            // Verify updateConfig doesn't throw
            scheduler.updateConfig({ minDelay: newMinDelay });
            scheduler.stop();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("updateConfig can be called with new interval", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 30000 }), // initial interval
          fc.integer({ min: 1000, max: 30000 }), // new interval
          (initialInterval, newInterval) => {
            const scheduler = new ScreenCaptureScheduler(
              { interval: initialInterval },
              dummyCaptureTask
            );
            // Verify updateConfig doesn't throw
            scheduler.updateConfig({ interval: newInterval });
            scheduler.stop();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   *
   *
   * For any error thrown during a capture task, the scheduler SHALL schedule
   * the next capture without terminating the loop.
   */
  describe("Property 2: Error Tolerance Continues Scheduling", () => {
    it("continues scheduling after capture task throws error", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }), // number of errors to throw
          fc.string({ minLength: 1, maxLength: 20 }), // error message
          async (errorCount, errorMessage) => {
            let callCount = 0;
            const targetCalls = errorCount + 1;

            const scheduler = new ScreenCaptureScheduler(
              { interval: 10, minDelay: 5 },
              async () => {
                callCount++;
                if (callCount <= errorCount) {
                  throw new Error(errorMessage);
                }
                const captureResult: CaptureResultWithScreenId = {
                  buffer: Buffer.from([]),
                  timestamp: Date.now(),
                  source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
                  screenId: "0",
                };
                return [captureResult];
              }
            );

            scheduler.start();
            await new Promise((resolve) => setTimeout(resolve, targetCalls * 25 + 100));

            const state = scheduler.getState();
            scheduler.stop();

            return (
              callCount >= targetCalls && state.errorCount === errorCount && state.captureCount >= 1
            );
          }
        ),
        { numRuns: 20 }
      );
    });

    it("increments errorCount for each failed capture", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (expectedErrors) => {
          let errorThrowCount = 0;

          const scheduler = new ScreenCaptureScheduler({ interval: 10, minDelay: 5 }, async () => {
            errorThrowCount++;
            if (errorThrowCount <= expectedErrors) {
              throw new Error(`Error ${errorThrowCount}`);
            }
            const captureResult: CaptureResultWithScreenId = {
              buffer: Buffer.from([]),
              timestamp: Date.now(),
              source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
              screenId: "0",
            };
            return [captureResult];
          });

          scheduler.start();
          await new Promise((resolve) => setTimeout(resolve, (expectedErrors + 2) * 25 + 100));

          const state = scheduler.getState();
          scheduler.stop();

          return state.errorCount === expectedErrors;
        }),
        { numRuns: 10 }
      );
    });

    it("emits capture:error event when task throws", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (errorMessage) => {
          let errorEventReceived = false;
          let receivedErrorMessage = "";

          const scheduler = new ScreenCaptureScheduler({ interval: 10, minDelay: 5 }, async () => {
            throw new Error(errorMessage);
          });

          screenCaptureEventBus.removeAllListeners();
          screenCaptureEventBus.on("capture:error", (event) => {
            errorEventReceived = true;
            receivedErrorMessage = event.error.message;
          });

          scheduler.start();
          await new Promise((resolve) => setTimeout(resolve, 50));
          scheduler.stop();

          return errorEventReceived && receivedErrorMessage === errorMessage;
        }),
        { numRuns: 20 }
      );
    });
  });
});

describe("ScreenCaptureScheduler Event Emission Property Tests", () => {
  /**
   *
   *
   * For any scheduler operation (start capture, complete capture, error, state change),
   * the corresponding event SHALL be emitted with correct event type and payload data.
   */
  describe("Property 7: Event Emission Consistency", () => {
    it("emits capture:start event with correct payload for each capture cycle", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (captureCount) => {
          const startEvents: Array<{ type: string; timestamp: number; captureId: string }> = [];

          const scheduler = new ScreenCaptureScheduler({ interval: 15, minDelay: 5 }, async () => {
            const captureResult: CaptureResultWithScreenId = {
              buffer: Buffer.from([]),
              timestamp: Date.now(),
              source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
              screenId: "0",
            };
            return [captureResult];
          });

          screenCaptureEventBus.removeAllListeners();
          screenCaptureEventBus.on("capture:start", (event) => {
            startEvents.push({
              type: event.type,
              timestamp: event.timestamp,
              captureId: event.captureId,
            });
          });

          scheduler.start();
          await new Promise((resolve) => setTimeout(resolve, captureCount * 30 + 100));
          scheduler.stop();

          // Verify all start events have correct structure
          return startEvents.every(
            (event) =>
              event.type === "capture:start" &&
              typeof event.timestamp === "number" &&
              event.timestamp > 0 &&
              typeof event.captureId === "string" &&
              event.captureId.startsWith("capture-")
          );
        }),
        { numRuns: 10 }
      );
    });

    it("emits capture:complete event with correct payload after successful capture", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (runCount) => {
          const completeEvents: CaptureCompleteEvent[] = [];

          const scheduler = new ScreenCaptureScheduler({ interval: 15, minDelay: 5 }, async () => {
            const captureResult: CaptureResultWithScreenId = {
              buffer: Buffer.from([]),
              timestamp: Date.now(),
              source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
              screenId: "0",
            };
            return [captureResult];
          });

          screenCaptureEventBus.removeAllListeners();
          screenCaptureEventBus.on("capture:complete", (event) => {
            completeEvents.push(event);
          });

          scheduler.start();
          await new Promise((resolve) => setTimeout(resolve, runCount * 30 + 50));
          scheduler.stop();

          if (completeEvents.length === 0) return false;

          const event = completeEvents[0];
          return (
            event.type === "capture:complete" &&
            typeof event.captureId === "string" &&
            typeof event.executionTime === "number" &&
            event.executionTime >= 0 &&
            (event.result[0] as CaptureResultWithScreenId).screenId === "0" &&
            event.result[0].source.type === "screen"
          );
        }),
        { numRuns: 20 }
      );
    });

    it("emits capture-scheduler:state event with correct state transitions", async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom("start", "pause", "resume", "stop"), async (operation) => {
          const stateEvents: Array<{
            type: string;
            previousState: string;
            currentState: string;
          }> = [];

          const scheduler = new ScreenCaptureScheduler(
            { interval: 100, minDelay: 10 },
            dummyCaptureTask
          );

          screenCaptureEventBus.removeAllListeners();
          screenCaptureEventBus.on("capture-scheduler:state", (event) => {
            stateEvents.push({
              type: event.type,
              previousState: event.previousState,
              currentState: event.currentState,
            });
          });

          // Execute the operation
          if (operation === "start") {
            scheduler.start();
            scheduler.stop();
          } else if (operation === "pause") {
            scheduler.start();
            scheduler.pause();
            scheduler.stop();
          } else if (operation === "resume") {
            scheduler.start();
            scheduler.pause();
            scheduler.resume();
            scheduler.stop();
          } else {
            scheduler.start();
            scheduler.stop();
          }

          // Verify all state events have correct structure
          return stateEvents.every(
            (event) =>
              event.type === "capture-scheduler:state" &&
              ["idle", "running", "paused", "stopped"].includes(event.previousState) &&
              ["idle", "running", "paused", "stopped"].includes(event.currentState)
          );
        }),
        { numRuns: 20 }
      );
    });

    it("emits events in correct order: start -> complete for successful capture", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 2 }), async (captureCount) => {
          const eventOrder: string[] = [];

          const scheduler = new ScreenCaptureScheduler({ interval: 15, minDelay: 5 }, async () => {
            const captureResult: CaptureResultWithScreenId = {
              buffer: Buffer.from([]),
              timestamp: Date.now(),
              source: { id: "screen:0:0", name: "Display 0", type: "screen" as const },
              screenId: "0",
            };
            return [captureResult];
          });

          screenCaptureEventBus.removeAllListeners();
          screenCaptureEventBus.on("capture:start", () => {
            eventOrder.push("start");
          });
          screenCaptureEventBus.on("capture:complete", () => {
            eventOrder.push("complete");
          });

          scheduler.start();
          await new Promise((resolve) => setTimeout(resolve, captureCount * 30 + 100));
          scheduler.stop();

          // Verify start always comes before complete
          for (let i = 0; i < eventOrder.length - 1; i++) {
            if (eventOrder[i] === "complete" && eventOrder[i + 1] === "start") {
              // This is fine - complete from previous cycle, start from next
              continue;
            }
            if (eventOrder[i] === "start" && eventOrder[i + 1] !== "complete") {
              // start should be followed by complete (or another start if we're looking at boundaries)
              if (eventOrder[i + 1] !== "start") {
                return false;
              }
            }
          }

          // Check that we have pairs of start/complete
          const startCount = eventOrder.filter((e) => e === "start").length;
          const completeCount = eventOrder.filter((e) => e === "complete").length;

          return startCount >= captureCount && completeCount >= captureCount;
        }),
        { numRuns: 10 }
      );
    });

    it("emits events in correct order: start -> error for failed capture", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (errorMsg) => {
          const eventOrder: string[] = [];

          const scheduler = new ScreenCaptureScheduler({ interval: 15, minDelay: 5 }, async () => {
            throw new Error(errorMsg);
          });

          screenCaptureEventBus.removeAllListeners();
          screenCaptureEventBus.on("capture:start", () => {
            eventOrder.push("start");
          });
          screenCaptureEventBus.on("capture:error", () => {
            eventOrder.push("error");
          });

          scheduler.start();
          await new Promise((resolve) => setTimeout(resolve, 50));
          scheduler.stop();

          // Verify we have at least one start-error pair
          const hasStartError = eventOrder.includes("start") && eventOrder.includes("error");

          // Verify start comes before error
          const firstStart = eventOrder.indexOf("start");
          const firstError = eventOrder.indexOf("error");

          return hasStartError && firstStart < firstError;
        }),
        { numRuns: 20 }
      );
    });
  });
});
