import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { mainI18n } from "./i18n-service";
import { getLogger } from "./logger";
import { APP_ROOT, RENDERER_DIST } from "../env";
import { llmUsageService } from "./llm-usage-service";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { userSettingService } from "./user-setting-service";
import {
  captureScheduleController,
  screenCaptureEventBus,
  screenCaptureModule,
  type CaptureSchedulerState,
  type CaptureSchedulerStateEvent,
} from "./screen-capture";

export interface TrayServiceConfig {
  /**
   * Function to create the main window.
   * Should return the created BrowserWindow and handle assignment to main process variable.
   */
  createWindow: () => BrowserWindow;
  /**
   * Function to get the current main window instance.
   */
  getMainWindow: () => BrowserWindow | null;
  /**
   * Callback before quitting the app (set flags, cleanup, then call app.quit()).
   */
  onQuit: () => void;
}

export class TrayService {
  private static instance: TrayService | null = null;
  private tray: Tray | null = null;
  private readonly logger = getLogger("tray-service");
  private config: TrayServiceConfig | null = null;
  private todayTokens: number = 0;
  private updateInterval: NodeJS.Timeout | null = null;
  private schedulerStatus: CaptureSchedulerState["status"] = "idle";

  private readonly handleSchedulerEventBound = (event: CaptureSchedulerStateEvent) => {
    this.schedulerStatus = event.currentState;
    this.refreshMenu();
    this.refreshTooltip();
    this.updateUsageDisplay();
  };

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): TrayService {
    if (!TrayService.instance) {
      TrayService.instance = new TrayService();
    }
    return TrayService.instance;
  }

  static resetInstance(): void {
    if (TrayService.instance) {
      TrayService.instance.dispose();
      TrayService.instance = null;
    }
  }

  configure(config: TrayServiceConfig) {
    this.config = config;
    return this;
  }

  private getIconPath(): string {
    const base = app.isPackaged ? RENDERER_DIST : path.join(APP_ROOT, "public");
    // macOS tray uses Template images (monochrome)
    if (process.platform === "darwin") {
      return path.join(base, "trayTemplate@2x.png");
    }
    // Windows requires .ico format for proper tray icon display
    if (process.platform === "win32") {
      return path.join(base, "logo.ico");
    }
    return path.join(base, "logo.png");
  }

  init(): void {
    if (this.tray) {
      this.logger.warn("Tray already initialized");
      return;
    }

    const base = app.isPackaged ? RENDERER_DIST : path.join(APP_ROOT, "public");
    const candidatePaths =
      process.platform === "win32"
        ? [path.resolve(path.join(base, "logo.ico")), path.resolve(path.join(base, "logo.png"))]
        : [path.resolve(this.getIconPath())];

    if (process.platform === "win32") {
      const iconPath = candidatePaths.find((p) => existsSync(p));
      if (!iconPath) {
        this.logger.warn({ path: candidatePaths }, "Tray icon file not found");
        return;
      }
      this.tray = new Tray(iconPath);
    } else {
      const resolvedIconPath = candidatePaths[0] ?? path.resolve(this.getIconPath());
      const iconExists = existsSync(resolvedIconPath);
      if (!iconExists) {
        this.logger.warn({ path: resolvedIconPath }, "Tray icon file not found");
      }
      const icon = nativeImage.createFromPath(resolvedIconPath);
      if (icon.isEmpty()) {
        this.logger.warn(
          { path: resolvedIconPath },
          "Tray icon is empty (file may be invalid or not found)"
        );
        return;
      }
      if (process.platform === "darwin") {
        icon.setTemplateImage(true);
      }
      this.tray = new Tray(icon);
    }

    // Snapshot initial status in case tray subscribes after scheduler already started.
    this.schedulerStatus = screenCaptureModule.getState().status;

    // Initial display
    this.refreshTooltip();
    this.refreshMenu();

    this.tray.on("click", this.handleShowMainWindow);
    this.tray.on("double-click", this.handleShowMainWindow);

    this.updateUsageDisplay(); // Fetch usage and refresh menu
    this.subscribeScheduler();

    // Update usage stats every 5 minutes
    this.updateInterval = setInterval(
      () => {
        this.updateUsageDisplay();
      },
      5 * 60 * 1000
    );

    this.logger.info({ icon: this.getIconPath() }, "Tray initialized");
  }

  /** Re-build menu and tooltip (e.g. after i18n becomes ready). */
  refresh(): void {
    this.refreshMenu();
    this.refreshTooltip();
  }

  dispose(): void {
    if (!this.tray) return;
    this.unsubscribeScheduler();
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.tray.removeAllListeners();
    this.tray.destroy();
    this.tray = null;
    this.logger.info("Tray disposed");
  }

  private async updateUsageDisplay() {
    try {
      const now = Date.now();
      const startOfDay = new Date(now).setHours(0, 0, 0, 0);

      const summary = await llmUsageService.getUsageSummary({
        fromTs: startOfDay,
        toTs: now,
      });

      this.todayTokens = summary.totalTokens;
      this.refreshMenu();
      this.refreshTooltip();
    } catch (error) {
      this.logger.warn({ error }, "Failed to update usage display");
    }
  }

  private refreshMenu(): void {
    if (!this.tray) return;

    const isRunning = this.schedulerStatus === "running";

    const menu = Menu.buildFromTemplate([
      {
        label: mainI18n.t("tray.usageToday", "", {
          count: this.todayTokens.toLocaleString(),
        } as Record<string, string>),
        click: () => {
          const mainWindow = this.handleShowMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send(IPC_CHANNELS.APP_NAVIGATE, "/settings/usage");
          }
        },
      },
      { type: "separator" },
      {
        label: mainI18n.t("tray.show"),
        click: this.handleShowMainWindow,
      },
      {
        label: isRunning ? mainI18n.t("tray.stopRecording") : mainI18n.t("tray.startRecording"),
        click: () => this.handleToggleRecording(),
      },
      { type: "separator" },
      {
        label: mainI18n.t("tray.quit"),
        click: this.handleQuit,
      },
    ]);

    this.tray.setContextMenu(menu);
  }

  private refreshTooltip(): void {
    if (!this.tray) return;
    const status = this.schedulerStatus;
    const statusText = mainI18n.t(`tray.status.${status}` as const);
    this.tray.setToolTip(`${app.getName()} - ${statusText}`);
  }

  private handleToggleRecording(): void {
    void this.handleToggleRecordingAsync();
  }

  private async handleToggleRecordingAsync(): Promise<void> {
    const isRunning = this.schedulerStatus === "running";

    try {
      if (isRunning) {
        this.logger.info("Stopping screen capture from tray");
        await userSettingService.setCaptureManualOverride("force_off");
        screenCaptureModule.stop();
        return;
      }

      this.logger.info("Starting screen capture from tray");
      await userSettingService.setCaptureManualOverride("force_on");
      await captureScheduleController.evaluateNow();
    } catch (error) {
      this.logger.error({ error }, "Failed to toggle screen capture from tray");
    }
  }

  private handleShowMainWindow = (): BrowserWindow | null => {
    try {
      if (!this.config) {
        this.logger.warn("TrayService not configured");
        return null;
      }
      let mainWindow = this.config.getMainWindow();
      if (!mainWindow) {
        mainWindow = this.config.createWindow();
      }
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      return mainWindow;
    } catch (error) {
      this.logger.error({ error }, "Failed to show main window from tray");
      return null;
    }
  };

  private handleQuit = (): void => {
    try {
      if (!this.config) {
        this.logger.warn("TrayService not configured");
        return;
      }
      this.config.onQuit();
    } catch (error) {
      this.logger.error({ error }, "Failed to quit app from tray");
    }
  };

  private subscribeScheduler(): void {
    screenCaptureEventBus.on("capture-scheduler:state", this.handleSchedulerEventBound);
  }

  private unsubscribeScheduler(): void {
    screenCaptureEventBus.off("capture-scheduler:state", this.handleSchedulerEventBound);
  }
}
