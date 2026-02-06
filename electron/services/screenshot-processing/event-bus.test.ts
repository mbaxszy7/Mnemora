import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { screenshotProcessingEventBus } from "./event-bus";

const threadsPayload = {
  type: "threads:changed" as const,
  timestamp: Date.now(),
  reason: "test",
  changedCount: 1,
};

describe("screenshotProcessingEventBus", () => {
  afterEach(() => screenshotProcessingEventBus.removeAllListeners());

  it("registers and fires event handlers via on()", () => {
    const handler = vi.fn();
    screenshotProcessingEventBus.on("threads:changed", handler);
    screenshotProcessingEventBus.emit("threads:changed", threadsPayload);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("on() returns unsubscribe function", () => {
    const handler = vi.fn();
    const unsub = screenshotProcessingEventBus.on("threads:changed", handler);
    unsub();
    screenshotProcessingEventBus.emit("threads:changed", threadsPayload);
    expect(handler).not.toHaveBeenCalled();
  });

  it("once() fires handler only once", () => {
    const handler = vi.fn();
    screenshotProcessingEventBus.once("threads:changed", handler);
    screenshotProcessingEventBus.emit("threads:changed", threadsPayload);
    screenshotProcessingEventBus.emit("threads:changed", threadsPayload);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("off() removes specific handler", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    screenshotProcessingEventBus.on("threads:changed", h1);
    screenshotProcessingEventBus.on("threads:changed", h2);
    screenshotProcessingEventBus.off("threads:changed", h1);
    screenshotProcessingEventBus.emit("threads:changed", threadsPayload);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("emit does nothing when no listeners registered", () => {
    expect(() =>
      screenshotProcessingEventBus.emit("threads:changed", threadsPayload)
    ).not.toThrow();
  });

  it("removeAllListeners with no args clears all", () => {
    const h1 = vi.fn();
    screenshotProcessingEventBus.on("threads:changed", h1);
    screenshotProcessingEventBus.removeAllListeners();
    screenshotProcessingEventBus.emit("threads:changed", threadsPayload);
    expect(h1).not.toHaveBeenCalled();
  });

  it("handles synchronous errors in handlers gracefully", () => {
    const thrower = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    screenshotProcessingEventBus.on("threads:changed", thrower);
    screenshotProcessingEventBus.on("threads:changed", second);
    expect(() =>
      screenshotProcessingEventBus.emit("threads:changed", threadsPayload)
    ).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
  });
});
