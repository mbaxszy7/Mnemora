import { BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { mainI18n } from "./i18n-service";
import { getLogger } from "./logger";
import { APP_ROOT, RENDERER_DIST, VITE_DEV_SERVER_URL } from "../env";
import { llmUsageService } from "./llm-usage-service";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { screenCaptureModule } from "./screen-capture/screen-capture-module";

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

  private readonly handleSchedulerEventBound = () => {
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
    const appRoot = process.env.APP_ROOT ?? APP_ROOT;
    const base = VITE_DEV_SERVER_URL ? path.join(appRoot, "public") : RENDERER_DIST;
    // macOS tray uses Template images (monochrome)
    if (process.platform === "darwin") {
      return path.join(base, "logoTemplate@2x.png");
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

    const resolvedIconPath = path.resolve(this.getIconPath());
    const icon = nativeImage.createFromPath(resolvedIconPath);
    this.tray = new Tray(icon);

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

    this.logger.info({ icon: resolvedIconPath }, "Tray initialized");
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

    const isRunning = screenCaptureModule.getState().status === "running";

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
    const status = screenCaptureModule.getState().status;
    const statusText = mainI18n.t(`tray.status.${status}` as const);
    this.tray.setToolTip(`Mnemora - ${statusText}`);
  }

  private handleToggleRecording(): void {
    const isRunning = screenCaptureModule.getState().status === "running";
    if (isRunning) {
      this.logger.info("Stopping screen capture from tray");
      screenCaptureModule.stop();
    } else {
      this.logger.info("Starting screen capture from tray");
      screenCaptureModule.tryInitialize();
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
    screenCaptureModule.on("capture-scheduler:state", this.handleSchedulerEventBound);
  }

  private unsubscribeScheduler(): void {
    screenCaptureModule.off("capture-scheduler:state", this.handleSchedulerEventBound);
  }
}
