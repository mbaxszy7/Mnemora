import { BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { getScreenCaptureModule } from "./screen-capture";
import { mainI18n } from "./i18n-service";
import { getLogger } from "./logger";
import { VITE_DEV_SERVER_URL, RENDERER_DIST } from "../main";

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
  private readonly handleSchedulerEventBound = () => {
    this.refreshMenu();
    this.refreshTooltip();
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
    const base = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT!, "public") : RENDERER_DIST;
    // macOS tray uses Template images (monochrome)
    if (process.platform === "darwin") {
      return path.join(base, "logoTemplate@2x.png");
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
    this.refreshTooltip();

    this.tray.on("click", this.handleShowMainWindow);
    this.tray.on("double-click", this.handleShowMainWindow);

    this.refreshMenu();
    this.subscribeScheduler();
    this.logger.info({ icon: resolvedIconPath }, "Tray initialized");
  }

  dispose(): void {
    if (!this.tray) return;
    this.unsubscribeScheduler();
    this.tray.removeAllListeners();
    this.tray.destroy();
    this.tray = null;
    this.logger.info("Tray disposed");
  }

  private refreshMenu(): void {
    if (!this.tray) return;

    const captureModule = getScreenCaptureModule();
    const isRunning = captureModule.getState().status === "running";

    const menu = Menu.buildFromTemplate([
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
    const status = getScreenCaptureModule().getState().status;
    const statusText = mainI18n.t(`tray.status.${status}` as const);
    this.tray.setToolTip(`Mnemora - ${statusText}`);
  }

  private handleToggleRecording(): void {
    const captureModule = getScreenCaptureModule();
    const isRunning = captureModule.getState().status === "running";
    if (isRunning) {
      this.logger.info("Stopping screen capture from tray");
      captureModule.stop();
    } else {
      this.logger.info("Starting screen capture from tray");
      captureModule.start();
    }
  }

  private handleShowMainWindow = (): void => {
    try {
      if (!this.config) {
        this.logger.warn("TrayService not configured");
        return;
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
    } catch (error) {
      this.logger.error({ error }, "Failed to show main window from tray");
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
    const captureModule = getScreenCaptureModule();
    captureModule.on("scheduler:state", this.handleSchedulerEventBound);
  }

  private unsubscribeScheduler(): void {
    const captureModule = getScreenCaptureModule();
    captureModule.off("scheduler:state", this.handleSchedulerEventBound);
  }
}
