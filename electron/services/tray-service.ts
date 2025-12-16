import { Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { getScreenCaptureModule } from "./screen-capture";
import { mainI18n } from "./i18n-service";
import { getLogger } from "./logger";

interface TrayServiceOptions {
  iconPath: string;
  /**
   * Show the main window (create if needed, restore if minimized, focus).
   */
  onShowMainWindow: () => void;
  /**
   * Callback before quitting the app (set flags, cleanup, then call app.quit()).
   */
  onQuit: () => void;
}

export class TrayService {
  private tray: Tray | null = null;
  private readonly logger = getLogger("tray-service");
  private readonly iconPath: string;
  private readonly onShowMainWindow: () => void;
  private readonly onQuit: () => void;
  private readonly handleSchedulerEventBound = () => {
    this.refreshMenu();
    this.refreshTooltip();
  };

  constructor(options: TrayServiceOptions) {
    this.iconPath = options.iconPath;
    this.onShowMainWindow = options.onShowMainWindow;
    this.onQuit = options.onQuit;
  }

  init(): void {
    if (this.tray) {
      this.logger.warn("Tray already initialized");
      return;
    }

    const resolvedIconPath = path.resolve(this.iconPath);
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
      this.onShowMainWindow();
    } catch (error) {
      this.logger.error({ error }, "Failed to show main window from tray");
    }
  };

  private handleQuit = (): void => {
    try {
      this.onQuit();
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
