import { app, autoUpdater, BrowserWindow, shell } from "electron";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import type { AppUpdateStatus } from "@shared/app-update-types";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { getLogger } from "./logger";
import { notificationService } from "./notification/notification-service";

const logger = getLogger("app-update-service");

const STABLE_RELEASES_API = "https://api.github.com/repos/mbaxszy7/Mnemora/releases/latest";

function createInitialStatus(): AppUpdateStatus {
  const now = Date.now();
  return {
    phase: "idle",
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseUrl: null,
    platformAction: "none",
    message: null,
    lastCheckedAt: null,
    updatedAt: now,
  };
}

function normalizeVersion(raw: string): string {
  return raw.replace(/^v/, "");
}

function compareVersions(a: string, b: string): number {
  const aParts = normalizeVersion(a)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const bParts = normalizeVersion(b)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i += 1) {
    const av = Number.isFinite(aParts[i]) ? aParts[i] : 0;
    const bv = Number.isFinite(bParts[i]) ? bParts[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  return 0;
}

class AppUpdateService {
  private static instance: AppUpdateService | null = null;

  private status: AppUpdateStatus = createInitialStatus();
  private initialized = false;
  private checking = false;
  private intervalId: NodeJS.Timeout | null = null;
  private notifiedAvailableVersion: string | null = null;
  private notifiedDownloadedVersion: string | null = null;

  static getInstance(): AppUpdateService {
    if (!AppUpdateService.instance) {
      AppUpdateService.instance = new AppUpdateService();
    }
    return AppUpdateService.instance;
  }

  static resetInstance(): void {
    AppUpdateService.instance?.dispose();
    AppUpdateService.instance = null;
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (!app.isPackaged) {
      this.updateStatus({
        phase: "idle",
        message: "Updates are disabled in development mode.",
        platformAction: "none",
      });
      return;
    }

    if (process.platform === "win32") {
      this.initializeWindowsUpdater();
    }

    void this.checkNow();
    this.intervalId = setInterval(
      () => {
        void this.checkNow();
      },
      60 * 60 * 1000
    );
  }

  dispose(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (process.platform === "win32") {
      autoUpdater.removeAllListeners();
    }

    this.initialized = false;
  }

  getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  async checkNow(): Promise<boolean> {
    if (this.checking) return false;
    this.checking = true;
    this.updateStatus({
      phase: "checking",
      platformAction: "none",
      message: null,
      lastCheckedAt: Date.now(),
    });

    try {
      if (process.platform === "win32") {
        autoUpdater.checkForUpdates();
      } else if (process.platform === "darwin") {
        await this.checkMacStableRelease();
      } else {
        this.updateStatus({
          phase: "not-available",
          platformAction: "none",
          message: "Updates are not supported on this platform.",
        });
      }
      return true;
    } catch (error) {
      logger.error({ error }, "Failed to trigger update check");
      this.updateStatus({
        phase: "error",
        platformAction: "none",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      this.checking = false;
    }
  }

  restartAndInstall(): void {
    if (process.platform !== "win32") return;
    autoUpdater.quitAndInstall();
  }

  async openDownloadPage(): Promise<{ url: string }> {
    const url = this.status.releaseUrl ?? "https://github.com/mbaxszy7/Mnemora/releases/latest";
    await shell.openExternal(url);
    return { url };
  }

  private initializeWindowsUpdater(): void {
    const updater = autoUpdater as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): void;
    };

    try {
      updateElectronApp({
        updateSource: {
          type: UpdateSourceType.ElectronPublicUpdateService,
          repo: "mbaxszy7/Mnemora",
        },
        updateInterval: "1 hour",
        notifyUser: false,
        logger: {
          log: (...args: unknown[]) => logger.info({ args }, "update-electron-app"),
          info: (...args: unknown[]) => logger.info({ args }, "update-electron-app"),
          warn: (...args: unknown[]) => logger.warn({ args }, "update-electron-app"),
          error: (...args: unknown[]) => logger.error({ args }, "update-electron-app"),
        },
      });
    } catch (error) {
      logger.error({ error }, "Failed to initialize update-electron-app");
    }

    updater.on("checking-for-update", () => {
      this.updateStatus({
        phase: "checking",
        platformAction: "none",
        message: null,
        lastCheckedAt: Date.now(),
      });
    });

    updater.on("update-available", (...args: unknown[]) => {
      const info = (args[0] ?? {}) as { version?: string; releaseNotes?: string };
      void this.notifyUpdateAvailable(info.version ?? null);
      this.updateStatus({
        phase: "downloading",
        availableVersion: info.version ?? null,
        platformAction: "none",
        message: info.releaseNotes ?? null,
      });
    });

    updater.on("update-not-available", () => {
      this.updateStatus({
        phase: "not-available",
        availableVersion: null,
        platformAction: "none",
        message: null,
      });
    });

    updater.on("update-downloaded", (...args: unknown[]) => {
      const info = (args[0] ?? {}) as { version?: string };
      void this.notifyUpdateDownloaded(info.version ?? null);
      this.updateStatus({
        phase: "downloaded",
        availableVersion: info.version ?? this.status.availableVersion,
        platformAction: "restart-and-install",
        message: null,
      });
    });

    updater.on("error", (...args: unknown[]) => {
      const error = args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? "Unknown"));
      logger.error({ error }, "Windows updater error");
      this.updateStatus({
        phase: "error",
        platformAction: "none",
        message: error.message,
      });
    });
  }

  private async checkMacStableRelease(): Promise<void> {
    const response = await fetch(STABLE_RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (!response.ok) {
      throw new Error(`Release check failed with status ${response.status}`);
    }

    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      name?: string;
      prerelease?: boolean;
      draft?: boolean;
    };

    const remoteVersion = normalizeVersion(release.tag_name ?? "");
    const currentVersion = normalizeVersion(app.getVersion());

    if (!remoteVersion || release.draft || release.prerelease) {
      this.updateStatus({
        phase: "not-available",
        platformAction: "none",
        availableVersion: null,
        releaseUrl: null,
        message: null,
      });
      return;
    }

    if (compareVersions(remoteVersion, currentVersion) <= 0) {
      this.updateStatus({
        phase: "not-available",
        platformAction: "none",
        availableVersion: null,
        releaseUrl: release.html_url ?? null,
        message: null,
      });
      return;
    }

    this.updateStatus({
      phase: "available",
      availableVersion: remoteVersion,
      releaseUrl: release.html_url ?? null,
      platformAction: "open-download-page",
      message: release.name ?? null,
    });
    await this.notifyUpdateAvailable(remoteVersion);
  }

  private async notifyUpdateAvailable(version: string | null): Promise<void> {
    if (!version || this.notifiedAvailableVersion === version) return;
    this.notifiedAvailableVersion = version;

    await notificationService.show({
      id: `app-update-available:${version}`,
      type: "app-update-available",
      priority: "normal",
      title: "notifications.appUpdateAvailable.title",
      body: "notifications.appUpdateAvailable.body",
      data: { version },
      toastActions: [
        { id: "open-settings-update", label: "notifications.actions.openSettingsUpdate" },
      ],
    });
  }

  private async notifyUpdateDownloaded(version: string | null): Promise<void> {
    const resolvedVersion = version ?? this.status.availableVersion;
    if (!resolvedVersion || this.notifiedDownloadedVersion === resolvedVersion) return;
    this.notifiedDownloadedVersion = resolvedVersion;

    await notificationService.show({
      id: `app-update-downloaded:${resolvedVersion}`,
      type: "app-update-downloaded",
      priority: "high",
      title: "notifications.appUpdateDownloaded.title",
      body: "notifications.appUpdateDownloaded.body",
      data: { version: resolvedVersion },
      toastActions: [{ id: "restart-update", label: "notifications.actions.restartUpdate" }],
    });
  }

  private updateStatus(patch: Partial<AppUpdateStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: app.getVersion(),
      updatedAt: Date.now(),
    };

    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(IPC_CHANNELS.APP_UPDATE_STATUS_CHANGED, this.status);
    }
  }
}

export const appUpdateService = AppUpdateService.getInstance();
export { AppUpdateService };
