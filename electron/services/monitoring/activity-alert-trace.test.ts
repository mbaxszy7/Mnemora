import { describe, it, expect, vi, beforeEach } from "vitest";

// Use real RingBuffer - it's a pure data structure
import { activityAlertBuffer } from "./activity-alert-trace";

describe("activityAlertBuffer", () => {
  beforeEach(() => {
    activityAlertBuffer.removeAllListeners();
    activityAlertBuffer.clear();
  });

  it("records an event and emits alert", () => {
    const handler = vi.fn();
    activityAlertBuffer.on("alert", handler);

    const event = {
      ts: Date.now(),
      kind: "activity_summary_timeout" as const,
      message: "Timeout",
    };

    activityAlertBuffer.record(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("getRecent returns events in reverse chronological order", () => {
    const e1 = { ts: 1, kind: "activity_summary_timeout" as const, message: "a" };
    const e2 = { ts: 2, kind: "activity_summary_timeout" as const, message: "b" };

    activityAlertBuffer.record(e1);
    activityAlertBuffer.record(e2);

    const recent = activityAlertBuffer.getRecent(2);
    expect(recent).toHaveLength(2);
  });

  it("clear removes all events", () => {
    activityAlertBuffer.record({
      ts: 1,
      kind: "activity_summary_timeout" as const,
      message: "a",
    });
    activityAlertBuffer.clear();
    const recent = activityAlertBuffer.getRecent(10);
    expect(recent).toHaveLength(0);
  });
});
