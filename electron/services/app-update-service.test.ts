import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
const mockSend = vi.hoisted(() => vi.fn());
const mockOpenExternal = vi.hoisted(() => vi.fn(async () => {}));
const mockCheckForUpdates = vi.hoisted(() => vi.fn());
const mockQuitAndInstall = vi.hoisted(() => vi.fn());
const mockUpdateElectronApp = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => "0.0.1"),
  },
  autoUpdater: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    }),
    checkForUpdates: mockCheckForUpdates,
    quitAndInstall: mockQuitAndInstall,
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: mockSend } }]),
  },
  shell: {
    openExternal: mockOpenExternal,
  },
}));

vi.mock("update-electron-app", () => ({
  updateElectronApp: mockUpdateElectronApp,
}));

vi.mock("./logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

import { AppUpdateService } from "./app-update-service";

describe("AppUpdateService", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    AppUpdateService.resetInstance();
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("detects available update on mac", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v0.0.2",
          html_url: "https://github.com/mbaxszy7/Mnemora/releases/tag/v0.0.2",
          prerelease: false,
          draft: false,
          name: "v0.0.2",
        }),
      }))
    );

    const service = AppUpdateService.getInstance();
    await service.checkNow();

    const status = service.getStatus();
    expect(status.phase).toBe("available");
    expect(status.availableVersion).toBe("0.0.2");
    expect(status.platformAction).toBe("open-download-page");
  });

  it("handles no update on mac", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v0.0.1",
          html_url: "https://github.com/mbaxszy7/Mnemora/releases/tag/v0.0.1",
          prerelease: false,
          draft: false,
        }),
      }))
    );

    const service = AppUpdateService.getInstance();
    await service.checkNow();

    const status = service.getStatus();
    expect(status.phase).toBe("not-available");
    expect(status.availableVersion).toBeNull();
  });

  it("opens release page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v0.0.2",
          html_url: "https://github.com/mbaxszy7/Mnemora/releases/tag/v0.0.2",
          prerelease: false,
          draft: false,
        }),
      }))
    );

    const service = AppUpdateService.getInstance();
    await service.checkNow();
    await service.openDownloadPage();

    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://github.com/mbaxszy7/Mnemora/releases/tag/v0.0.2"
    );
  });

  it("sets restart action when update is downloaded on windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const service = AppUpdateService.getInstance();

    service.initialize();
    listeners.get("update-downloaded")?.({ version: "0.0.2" });

    const status = service.getStatus();
    expect(status.phase).toBe("downloaded");
    expect(status.platformAction).toBe("restart-and-install");

    service.restartAndInstall();
    expect(mockQuitAndInstall).toHaveBeenCalledTimes(1);
  });
});
