import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { screenCaptureEventBus } from "./event-bus";

const startPayload = {
  type: "capture:start" as const,
  captureId: "c1",
  timestamp: Date.now(),
  intervalMs: 5000,
};

describe("screenCaptureEventBus", () => {
  afterEach(() => screenCaptureEventBus.removeAllListeners());

  it("registers and fires event handlers via on()", () => {
    const handler = vi.fn();
    screenCaptureEventBus.on("capture:start", handler);
    screenCaptureEventBus.emit("capture:start", startPayload);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("on() returns unsubscribe function", () => {
    const handler = vi.fn();
    const unsub = screenCaptureEventBus.on("capture:start", handler);
    unsub();
    screenCaptureEventBus.emit("capture:start", startPayload);
    expect(handler).not.toHaveBeenCalled();
  });

  it("once() fires handler only once", () => {
    const handler = vi.fn();
    screenCaptureEventBus.once("capture:start", handler);
    screenCaptureEventBus.emit("capture:start", startPayload);
    screenCaptureEventBus.emit("capture:start", startPayload);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("off() removes specific handler", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    screenCaptureEventBus.on("capture:start", h1);
    screenCaptureEventBus.on("capture:start", h2);
    screenCaptureEventBus.off("capture:start", h1);
    screenCaptureEventBus.emit("capture:start", startPayload);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("off() on non-existent event does nothing", () => {
    const handler = vi.fn();
    expect(() => screenCaptureEventBus.off("capture:start", handler)).not.toThrow();
  });

  it("emit does nothing when no listeners registered", () => {
    expect(() => screenCaptureEventBus.emit("capture:start", startPayload)).not.toThrow();
  });

  it("removeAllListeners clears specific event", () => {
    const h1 = vi.fn();
    screenCaptureEventBus.on("capture:start", h1);
    screenCaptureEventBus.removeAllListeners("capture:start");
    screenCaptureEventBus.emit("capture:start", startPayload);
    expect(h1).not.toHaveBeenCalled();
  });

  it("removeAllListeners with no args clears all", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    screenCaptureEventBus.on("capture:start", h1);
    screenCaptureEventBus.on("capture:error", h2);
    screenCaptureEventBus.removeAllListeners();
    screenCaptureEventBus.emit("capture:start", startPayload);
    screenCaptureEventBus.emit("capture:error", {
      type: "capture:error",
      captureId: "c1",
      timestamp: Date.now(),
      error: new Error("test"),
    });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("handles synchronous errors in handlers gracefully", () => {
    const thrower = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    screenCaptureEventBus.on("capture:start", thrower);
    screenCaptureEventBus.on("capture:start", second);
    expect(() => screenCaptureEventBus.emit("capture:start", startPayload)).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
  });

  it("off() cleans up empty listener set", () => {
    const handler = vi.fn();
    screenCaptureEventBus.on("capture:start", handler);
    screenCaptureEventBus.off("capture:start", handler);
    // Emit should be no-op now
    screenCaptureEventBus.emit("capture:start", startPayload);
    expect(handler).not.toHaveBeenCalled();
  });
});
