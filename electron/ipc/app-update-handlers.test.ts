import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockService = vi.hoisted(() => ({
  initialize: vi.fn(),
  getStatus: vi.fn(() => ({
    phase: "idle",
    currentVersion: "0.0.1",
    availableVersion: null,
    releaseUrl: null,
    platformAction: "none",
    message: null,
    lastCheckedAt: null,
    updatedAt: Date.now(),
  })),
  checkNow: vi.fn(async () => true),
  restartAndInstall: vi.fn(),
  openDownloadPage: vi.fn(async () => ({ url: "https://example.com" })),
}));

vi.mock("./handler-registry", () => ({
  IPCHandlerRegistry: {
    getInstance: vi.fn(() => ({
      registerHandler: vi.fn(
        (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(channel, handler);
        }
      ),
    })),
  },
}));

vi.mock("../services/app-update-service", () => ({
  appUpdateService: mockService,
}));

vi.mock("../services/logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

import { registerAppUpdateHandlers } from "./app-update-handlers";

describe("registerAppUpdateHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  it("registers handlers and serves status", async () => {
    registerAppUpdateHandlers();
    expect(handlers.has(IPC_CHANNELS.APP_UPDATE_GET_STATUS)).toBe(true);

    const handler = handlers.get(IPC_CHANNELS.APP_UPDATE_GET_STATUS);
    const result = (await handler?.({} as never)) as { success: boolean; data?: unknown };

    expect(result.success).toBe(true);
    expect(mockService.getStatus).toHaveBeenCalledTimes(1);
  });

  it("triggers check now", async () => {
    registerAppUpdateHandlers();
    const handler = handlers.get(IPC_CHANNELS.APP_UPDATE_CHECK_NOW);
    const result = (await handler?.({} as never)) as {
      success: boolean;
      data?: { started: boolean };
    };

    expect(result.success).toBe(true);
    expect(result.data?.started).toBe(true);
    expect(mockService.initialize).toHaveBeenCalledWith({ autoCheck: false, startInterval: true });
    expect(mockService.checkNow).toHaveBeenCalledTimes(1);
  });

  it("opens download page", async () => {
    registerAppUpdateHandlers();
    const handler = handlers.get(IPC_CHANNELS.APP_UPDATE_OPEN_DOWNLOAD_PAGE);
    const result = (await handler?.({} as never)) as {
      success: boolean;
      data?: { url: string };
    };

    expect(result.success).toBe(true);
    expect(result.data?.url).toBe("https://example.com");
    expect(mockService.initialize).toHaveBeenCalledWith({ autoCheck: false, startInterval: true });
  });
});
