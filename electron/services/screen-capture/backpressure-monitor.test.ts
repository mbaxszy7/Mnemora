import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockEmit, mockGetDb, mockPendingCount } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockGetDb: vi.fn(),
  mockPendingCount: { value: 0 },
}));

vi.mock("../../database", () => ({
  getDb: mockGetDb,
}));

vi.mock("../../database/schema", () => ({
  batches: { vlmStatus: "vlmStatus" },
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("./event-bus", () => ({
  screenCaptureEventBus: {
    emit: mockEmit,
  },
}));

vi.mock("../screenshot-processing/config", () => ({
  processingConfig: {
    backpressure: {
      checkIntervalMs: 100,
      recoveryHysteresisMs: 5000,
      levels: [
        { maxPending: 5, intervalMultiplier: 1, phashThreshold: 10 },
        { maxPending: 15, intervalMultiplier: 2, phashThreshold: 8 },
        { maxPending: 999, intervalMultiplier: 4, phashThreshold: 5 },
      ],
    },
  },
}));

import { BackpressureMonitor } from "./backpressure-monitor";

function setupDbMock(count: number = 0) {
  mockPendingCount.value = count;
  mockGetDb.mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => ({ count: mockPendingCount.value }),
        }),
      }),
    }),
  });
}

describe("BackpressureMonitor", () => {
  let monitor: BackpressureMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    setupDbMock(0);
    monitor = new BackpressureMonitor();
    mockEmit.mockClear();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("starts and stops without error", () => {
    monitor.start();
    monitor.stop();
  });

  it("start is idempotent", () => {
    monitor.start();
    monitor.start();
    monitor.stop();
  });

  it("stop is idempotent", () => {
    monitor.stop();
    monitor.stop();
  });

  it("getCurrentLevel returns 0 initially", () => {
    expect(monitor.getCurrentLevel()).toBe(0);
  });

  it("check() detects level increase when pending count rises", async () => {
    setupDbMock(10);
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(monitor.getCurrentLevel()).toBe(1);
    expect(mockEmit).toHaveBeenCalledWith(
      "backpressure:level-changed",
      expect.objectContaining({ level: 1 })
    );
  });

  it("check() detects level 2 for high pending count", async () => {
    setupDbMock(20);
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(monitor.getCurrentLevel()).toBe(2);
  });

  it("stays at level 0 when pending count is low", async () => {
    setupDbMock(3);
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(monitor.getCurrentLevel()).toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("recovery is deferred by hysteresis grace period", async () => {
    // First, push to level 1
    setupDbMock(10);
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(monitor.getCurrentLevel()).toBe(1);

    // Now pending drops, but recovery should be deferred
    setupDbMock(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(monitor.getCurrentLevel()).toBe(1); // still 1 due to hysteresis
  });

  it("recovery happens after hysteresis period", async () => {
    // Push to level 1
    setupDbMock(10);
    monitor.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(monitor.getCurrentLevel()).toBe(1);

    // Advance past grace period (5000ms) + check interval
    setupDbMock(0);
    await vi.advanceTimersByTimeAsync(5200);
    expect(monitor.getCurrentLevel()).toBe(0);
  });

  it("handles DB error gracefully during check", async () => {
    mockGetDb.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            get: () => {
              throw new Error("DB error");
            },
          }),
        }),
      }),
    });

    monitor.start();
    // Should not throw
    await vi.advanceTimersByTimeAsync(150);
    expect(monitor.getCurrentLevel()).toBe(0);
  });
});
