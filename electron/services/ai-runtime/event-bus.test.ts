import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { aiRuntimeEventBus } from "./event-bus";

const fusePayload = {
  type: "ai-fuse:tripped" as const,
  timestamp: Date.now(),
  payload: {
    windowMs: 60000,
    threshold: 3,
    count: 3,
    last: { capability: "vlm" as const, message: "test error" },
  },
};

describe("aiRuntimeEventBus", () => {
  afterEach(() => aiRuntimeEventBus.removeAllListeners());

  it("registers and fires event handlers via on()", () => {
    const handler = vi.fn();
    aiRuntimeEventBus.on("ai-fuse:tripped", handler);
    aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("on() returns unsubscribe function", () => {
    const handler = vi.fn();
    const unsub = aiRuntimeEventBus.on("ai-fuse:tripped", handler);
    unsub();
    aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload);
    expect(handler).not.toHaveBeenCalled();
  });

  it("once() fires handler only once", () => {
    const handler = vi.fn();
    aiRuntimeEventBus.once("ai-fuse:tripped", handler);
    aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload);
    aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("off() removes specific handler", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    aiRuntimeEventBus.on("ai-fuse:tripped", h1);
    aiRuntimeEventBus.on("ai-fuse:tripped", h2);
    aiRuntimeEventBus.off("ai-fuse:tripped", h1);
    aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("emit() does nothing when no listeners", () => {
    expect(() => aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload)).not.toThrow();
  });

  it("removeAllListeners() clears specific event", () => {
    const handler = vi.fn();
    aiRuntimeEventBus.on("ai-fuse:tripped", handler);
    aiRuntimeEventBus.removeAllListeners("ai-fuse:tripped");
    aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload);
    expect(handler).not.toHaveBeenCalled();
  });

  it("removeAllListeners() with no args clears all events", () => {
    const h1 = vi.fn();
    aiRuntimeEventBus.on("ai-fuse:tripped", h1);
    aiRuntimeEventBus.removeAllListeners();
    aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload);
    expect(h1).not.toHaveBeenCalled();
  });

  it("handles synchronous errors in handlers gracefully", () => {
    const thrower = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    aiRuntimeEventBus.on("ai-fuse:tripped", thrower);
    aiRuntimeEventBus.on("ai-fuse:tripped", second);
    expect(() => aiRuntimeEventBus.emit("ai-fuse:tripped", fusePayload)).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
  });
});
