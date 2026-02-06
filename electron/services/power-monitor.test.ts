import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
const mockSend = vi.hoisted(() => vi.fn());
const mockStart = vi.hoisted(() => vi.fn(() => 7));
const mockStop = vi.hoisted(() => vi.fn());
const mockIsStarted = vi.hoisted(() => vi.fn(() => true));
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }]),
  },
  powerMonitor: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    }),
    removeAllListeners: vi.fn(),
  },
  powerSaveBlocker: {
    start: mockStart,
    stop: mockStop,
    isStarted: mockIsStarted,
  },
}));

vi.mock("./logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

import { powerMonitorService } from "./power-monitor";

describe("powerMonitorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    powerMonitorService.dispose();
  });

  it("initializes once and starts blocker", () => {
    powerMonitorService.initialize();
    powerMonitorService.initialize();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("runs suspend callbacks and notifies renderer", () => {
    const callback = vi.fn();
    powerMonitorService.registerSuspendCallback(callback);
    powerMonitorService.initialize();

    listeners.get("suspend")?.();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith("power-monitor:event", { eventType: "suspend" });
  });

  it("disposes and stops blocker", () => {
    powerMonitorService.initialize();
    powerMonitorService.dispose();
    expect(mockStop).toHaveBeenCalledWith(7);
  });
});
