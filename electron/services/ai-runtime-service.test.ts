import { describe, it, expect, vi, beforeEach } from "vitest";

import { __testing } from "./ai-runtime-service";
import type { AIFailureFuseTrippedPayload } from "@shared/ipc-types";
import type { LLMConfig } from "@shared/llm-config-types";

const { AIRuntimeService, Semaphore } = __testing;

describe("Semaphore", () => {
  it("throws when permits <= 0", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  it("acquire/release works and maintains FIFO waiting queue", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const release1 = await sem.acquire();

    const p1 = sem.acquire().then((r) => {
      order.push(1);
      return r;
    });
    const p2 = sem.acquire().then((r) => {
      order.push(2);
      return r;
    });

    release1();
    const r1 = await p1;
    r1();
    const r2 = await p2;
    r2();

    expect(order).toEqual([1, 2]);
  });

  it("setLimit lowers permits and unblocks waiters", async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    const waiting = sem.acquire().then((r) => {
      r();
      return "acquired";
    });

    // reduce limit to 1; should not throw and should keep a waiter
    sem.setLimit(1);
    release1();
    release2();

    expect(await waiting).toBe("acquired");
    expect(sem.getLimit()).toBe(1);
  });
});

describe("AIRuntimeService", () => {
  let now: number;
  let sendToAllWindows: ReturnType<typeof vi.fn<(payload: AIFailureFuseTrippedPayload) => void>>;
  let validateConfig: ReturnType<
    typeof vi.fn<(config: LLMConfig) => Promise<{ success: boolean }>>
  >;
  let service: InstanceType<typeof AIRuntimeService>;

  beforeEach(() => {
    now = 0;
    sendToAllWindows = vi.fn<(payload: AIFailureFuseTrippedPayload) => void>();
    validateConfig = vi.fn<(config: LLMConfig) => Promise<{ success: boolean }>>(async () => ({
      success: true,
    }));
    service = new AIRuntimeService({
      nowFn: () => now,
      sendToAllWindows,
      validateConfig,
    });
  });

  const tripBreaker = () => {
    service.recordFailure("text", new Error("f1"));
    service.recordFailure("text", new Error("f2"));
    service.recordFailure("text", new Error("f3"));
  };

  it("adaptive tuner halves limit on consecutive failures after cooldown", () => {
    const before = service.getLimit("text");
    // first failure within cooldown -> no change
    service.recordFailure("text", new Error("fail1"));
    expect(service.getLimit("text")).toBe(before);

    // advance time beyond cooldown and trigger second consecutive failure
    now = 31_000;
    service.recordFailure("text", new Error("fail2"));

    const after = service.getLimit("text");
    expect(after).toBeLessThan(before);
    expect(after).toBe(Math.max(1, Math.floor(before / 2)));
  });

  it("adaptive tuner recovers towards base after sufficient successes and cooldown", () => {
    const base = service.getLimit("text");

    // Force a downgrade first
    service.recordFailure("text", new Error("fail1"));
    now = 31_000;
    service.recordFailure("text", new Error("fail2"));
    const degraded = service.getLimit("text");
    expect(degraded).toBeLessThan(base);

    // Advance time beyond cooldown and push enough successes to recover
    now = 62_000;
    for (let i = 0; i < 25; i++) {
      service.recordSuccess("text");
    }

    const recovered = service.getLimit("text");
    expect(recovered).toBeGreaterThanOrEqual(degraded);
    expect(recovered).toBeLessThanOrEqual(base);
  });

  it("recordFailure with tripBreaker: false does not trip breaker", () => {
    for (let i = 0; i < 5; i++) {
      service.recordFailure("text", new Error("ignored"), { tripBreaker: false });
    }
    expect(service.isTripped()).toBe(false);
    expect(sendToAllWindows).not.toHaveBeenCalled();
  });

  it("trips breaker and notifies windows when threshold reached", () => {
    tripBreaker();
    expect(service.isTripped()).toBe(true);
    expect(sendToAllWindows).toHaveBeenCalledTimes(1);
    const payload = sendToAllWindows.mock.calls[0][0];
    expect(payload.count).toBeGreaterThanOrEqual(3);
    expect(payload.last.capability).toBe("text");
  });

  it("stops and auto-resumes capture after successful config validation", async () => {
    const stop = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    service.registerCaptureControlCallbacks({
      stop,
      start,
      getState: () => ({ status: "running" }),
    });

    tripBreaker();
    expect(stop).toHaveBeenCalledTimes(1);

    const dummyConfig = { mode: "unified", config: {} } as unknown as LLMConfig;
    await service.handleConfigSaved(dummyConfig);

    expect(validateConfig).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(service.isTripped()).toBe(false);
  });
});
