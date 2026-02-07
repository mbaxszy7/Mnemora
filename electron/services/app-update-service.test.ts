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
const mockShowNotification = vi.hoisted(() => vi.fn(async () => {}));

const mockIsPackaged = vi.hoisted(() => ({ value: true }));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged.value;
    },
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

vi.mock("./notification/notification-service", () => ({
  notificationService: {
    show: mockShowNotification,
  },
}));

import { AppUpdateService } from "./app-update-service";

describe("AppUpdateService", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    AppUpdateService.resetInstance();
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockIsPackaged.value = true;
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

  it("prevents concurrent update checks on windows until terminal event", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const service = AppUpdateService.getInstance();
    service.initialize();

    const first = await service.checkNow();
    const second = await service.checkNow();

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1); // initialize only while lock is held

    listeners.get("update-not-available")?.();
    const third = await service.checkNow();
    expect(third).toBe(true);
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(2);
  });

  it("throws on restartAndInstall when platform is not windows", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const service = AppUpdateService.getInstance();

    expect(() => service.restartAndInstall()).toThrow(
      "Restart-and-install is only supported on Windows."
    );
  });

  it("throws on restartAndInstall before package download on windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const service = AppUpdateService.getInstance();
    service.initialize();

    expect(() => service.restartAndInstall()).toThrow("Update package is not ready to install.");
  });

  it("handles unsupported platforms with not-available status", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const service = AppUpdateService.getInstance();

    await service.checkNow();
    const status = service.getStatus();
    expect(status.phase).toBe("not-available");
    expect(status.message).toContain("not supported");
  });

  it("returns error status when mac release check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
      }))
    );

    const service = AppUpdateService.getInstance();
    const result = await service.checkNow();
    const status = service.getStatus();

    expect(result).toBe(false);
    expect(status.phase).toBe("error");
    expect(status.message).toContain("503");
  });

  it("treats draft or prerelease as not available on mac", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v0.0.2",
          html_url: "https://github.com/mbaxszy7/Mnemora/releases/tag/v0.0.2",
          prerelease: true,
          draft: false,
        }),
      }))
    );

    const service = AppUpdateService.getInstance();
    await service.checkNow();
    const status = service.getStatus();

    expect(status.phase).toBe("not-available");
    expect(status.releaseUrl).toBeNull();
  });

  it("does not initialize updater checks in development mode", () => {
    mockIsPackaged.value = false;
    Object.defineProperty(process, "platform", { value: "win32" });
    const service = AppUpdateService.getInstance();

    service.initialize();
    expect(mockCheckForUpdates).not.toHaveBeenCalled();
    expect(service.getStatus().message).toContain("disabled in development mode");
  });

  it("opens default latest release page when release url is absent", async () => {
    const service = AppUpdateService.getInstance();
    const result = await service.openDownloadPage();

    expect(result.url).toBe("https://github.com/mbaxszy7/Mnemora/releases/latest");
    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://github.com/mbaxszy7/Mnemora/releases/latest"
    );
  });

  it("handles non-Error updater error payload on windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const service = AppUpdateService.getInstance();
    service.initialize();

    listeners.get("error")?.("network down");
    const status = service.getStatus();
    expect(status.phase).toBe("error");
    expect(status.message).toBe("network down");
  });
});
