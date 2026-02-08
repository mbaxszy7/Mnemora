import { app, BrowserWindow, Menu, nativeImage, screen, ipcMain } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { APP_ROOT, isDev, MAIN_DIST, RENDERER_DIST, VITE_DEV_SERVER_URL, VITE_PUBLIC } from "./env";
import { AISDKService } from "./services/ai-sdk-service";
import { LLMConfigService } from "./services/llm-config-service";
import { registerI18nHandlers } from "./ipc/i18n-handlers";
import { registerLLMConfigHandlers } from "./ipc/llm-config-handlers";
import { registerScreenCaptureHandlers } from "./ipc/screen-capture-handlers";
import { registerPermissionHandlers } from "./ipc/permission-handlers";
import { registerCaptureSourceSettingsHandlers } from "./ipc/capture-source-settings-handlers";
import { registerUserSettingsHandlers } from "./ipc/user-settings-handlers";
import { registerContextGraphHandlers } from "./ipc/context-graph-handlers";
import { registerThreadsHandlers } from "./ipc/threads-handlers";
import { registerUsageHandlers } from "./ipc/usage-handlers";
import { registerActivityMonitorHandlers } from "./ipc/activity-monitor-handlers";
import { registerMonitoringHandlers } from "./ipc/monitoring-handlers";
import { registerAppHandlers } from "./ipc/app-handlers";
import { registerAppUpdateHandlers } from "./ipc/app-update-handlers";
import { registerNotificationHandlers } from "./ipc/notification-handlers";
import { IPCHandlerRegistry } from "./ipc/handler-registry";
import { initializeLogger, getLogger } from "./services/logger";
import { mainI18n } from "./services/i18n-service";
import { databaseService } from "./database";
import { captureScheduleController, screenCaptureModule } from "./services/screen-capture";
import { screenshotProcessingModule } from "./services/screenshot-processing/screenshot-processing-module";
import { powerMonitorService } from "./services/power-monitor";
import { TrayService } from "./services/tray-service";
import { monitoringServer } from "./services/monitoring";
import { userSettingService } from "./services/user-setting-service";
import { notificationService } from "./services/notification/notification-service";
import { appUpdateService } from "./services/app-update-service";
import { ftsHealthService } from "./services/fts-health-service";
import type { BootMessageKey, BootPhase, BootStatus, IPCResult } from "../shared/ipc-types";

// ============================================================================
// Environment Setup
// ============================================================================

process.env.APP_ROOT = process.env.APP_ROOT ?? APP_ROOT;
process.env.VITE_PUBLIC = process.env.VITE_PUBLIC ?? VITE_PUBLIC;

if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? "com.mnemora.app" : "Mnemora");
}

// ============================================================================
// Single Instance Lock (production only)
// ============================================================================

const gotTheLock = isDev ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

// ============================================================================
// Window Management
// ============================================================================

class AppLifecycleController {
  private mainWindow: BrowserWindow | null = null;
  private logger!: ReturnType<typeof getLogger>;
  private trayService: TrayService | null = null;
  private isQuitting = false;
  private started = false;
  private disposed = false;
  private latestBootStatus: BootStatus | null = null;

  focusMainWindow(): void {
    const win = this.mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    app.on("before-quit", () => {
      this.isQuitting = true;
      this.dispose();
    });

    app.on("activate", () => {
      if (this.mainWindow) {
        this.mainWindow.show();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        void this.createAndBoot();
      }
    });

    await app.whenReady();
    Menu.setApplicationMenu(null);

    initializeLogger();
    this.logger = getLogger("main");
    this.logger.info("App is ready, starting boot sequence...");

    appUpdateService.initialize();
    await this.createAndBoot();
  }

  /**
   * Create window and start boot sequence
   */
  private async createAndBoot(): Promise<void> {
    // 1. Create main window immediately (showing splash)
    this.mainWindow = this.createMainWindow();
    this.trayService = TrayService.getInstance();
    this.trayService
      .configure({
        createWindow: () => {
          this.mainWindow = this.createMainWindow();
          return this.mainWindow;
        },
        getMainWindow: () => this.mainWindow,
        onQuit: () => {
          this.isQuitting = true;
          app.quit();
        },
      })
      .init();

    // 2. Register boot-related IPC handlers
    this.registerBootHandlers();

    // 3. Run boot sequence in background
    void this.runBootSequence();
  }

  /**
   * Register IPC handlers for boot status
   */
  private registerBootHandlers(): void {
    ipcMain.handle("boot:get-status", () => this.getCurrentBootStatus());
    ipcMain.handle("boot:retry-fts-repair", () => this.handleRetryFtsRepair());
  }

  /**
   * Get current boot status
   */
  private getCurrentBootStatus(): IPCResult<BootStatus> {
    const status: BootStatus = this.latestBootStatus ?? {
      phase: "db-init",
      progress: 0,
      messageKey: "boot.phase.dbInit",
      timestamp: Date.now(),
    };
    return { success: true, data: status };
  }

  /**
   * Emit boot status to all listeners
   */
  private emitBootStatus(phase: BootPhase, error?: { code: string; message: string }): void {
    const progress = this.getPhaseProgress(phase);
    const status: BootStatus = {
      phase,
      progress,
      messageKey: this.getPhaseI18nKey(phase),
      timestamp: Date.now(),
      ...(error && { errorCode: error.code, errorMessage: error.message }),
    };

    this.latestBootStatus = status;
    this.logger.debug({ phase, progress }, "Boot status changed");

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("boot:status-changed", status);
    }
  }

  /**
   * Emit FTS health to renderer
   */
  private emitFtsHealth(): void {
    const health = ftsHealthService.getDetails();

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("boot:fts-health-changed", health);
    }
  }

  /**
   * Get progress for a boot phase
   */
  private getPhaseProgress(phase: BootPhase): number {
    const progressMap: Record<BootPhase, number> = {
      "db-init": 15,
      "fts-check": 35,
      "fts-rebuild": 70,
      "app-init": 90,
      ready: 100,
      degraded: 100,
      failed: 100,
    };
    return progressMap[phase];
  }

  /**
   * Get i18n key for a boot phase
   */
  private getPhaseI18nKey(phase: BootPhase): BootMessageKey {
    const keyMap: Record<BootPhase, BootMessageKey> = {
      "db-init": "boot.phase.dbInit",
      "fts-check": "boot.phase.ftsCheck",
      "fts-rebuild": "boot.phase.ftsRebuild",
      "app-init": "boot.phase.appInit",
      ready: "boot.phase.ready",
      degraded: "boot.phase.degraded",
      failed: "boot.phase.failed",
    };
    return keyMap[phase];
  }

  /**
   * Run the boot sequence
   */
  private async runBootSequence(): Promise<void> {
    try {
      // Phase 1: Database initialization
      this.emitBootStatus("db-init");
      this.registerIPCHandlers();
      this.initDatabaseService();

      // Phase 2: FTS5 health check
      this.emitBootStatus("fts-check");
      const sqlite = databaseService.getSqlite();
      if (sqlite) {
        const ftsResult = await ftsHealthService.runStartupCheckAndHeal(sqlite, () => {
          this.emitBootStatus("fts-rebuild");
        });
        this.emitFtsHealth();

        // Phase 3: App services initialization
        this.emitBootStatus("app-init");
        await this.initializeAppServices();

        // Final phase: ready or degraded
        if (ftsResult.status === "healthy") {
          this.emitBootStatus("ready");
        } else {
          this.emitBootStatus("degraded", {
            code: ftsResult.errorCode || "FTS_UNHEALTHY",
            message: ftsResult.error || "FTS5 is unavailable",
          });
        }
      } else {
        throw new Error("Database not initialized");
      }
    } catch (error) {
      this.logger.error({ error }, "Boot sequence failed");
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitBootStatus("failed", {
        code: "BOOT_FAILED",
        message: errorMessage,
      });
    }
  }

  /**
   * Handle manual FTS repair retry
   */
  private async handleRetryFtsRepair(): Promise<IPCResult<{ success: boolean; error?: string }>> {
    try {
      const sqlite = databaseService.getSqlite();
      if (!sqlite) {
        return { success: true, data: { success: false, error: "Database not available" } };
      }

      const result = await ftsHealthService.retryRepair(sqlite, () => {
        this.emitBootStatus("fts-rebuild");
      });
      this.emitFtsHealth();

      if (result.status === "healthy") {
        this.emitBootStatus("ready");
        return { success: true, data: { success: true } };
      } else {
        this.emitBootStatus("degraded", {
          code: result.errorCode || "FTS_RETRY_FAILED",
          message: result.error || "FTS5 repair failed",
        });
        return { success: true, data: { success: false, error: result.error } };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: true, data: { success: false, error: errorMessage } };
    }
  }

  /**
   * Initialize app services (non-critical)
   */
  private async initializeAppServices(): Promise<void> {
    await userSettingService.getSettings();
    captureScheduleController.initialize({ screenCapture: screenCaptureModule });
    captureScheduleController.start();
    await this.initI18nService();
    notificationService.registerEventBusSubscriptions();
    await this.initAIService();
    this.initPowerMonitor();
    await this.initMonitoringServer();

    // OCR warmup (non-blocking)
    void this.tryWarmupOcrService();
  }

  private async tryWarmupOcrService(): Promise<void> {
    // Only warm up if FTS is healthy
    if (!ftsHealthService.isFtsUsable()) {
      this.logger.info("Skipping OCR warmup - FTS is not usable");
      return;
    }

    try {
      await screenshotProcessingModule.ocrWarmup();
    } catch (error) {
      this.logger.warn({ error }, "Failed to warm up OCR service");
    }
  }

  private async initI18nService(): Promise<void> {
    try {
      await mainI18n.initialize();
      this.logger.info("i18n service initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize i18n service");
    }
  }

  private async initAIService(): Promise<void> {
    try {
      const llmConfigService = LLMConfigService.getInstance();
      const config = await llmConfigService.loadConfiguration();

      if (!config) {
        this.logger.info("No LLM configuration found in database, AISDKService not initialized");
        return;
      }

      const aiService = AISDKService.getInstance();
      aiService.initialize(config);
      this.logger.info(
        { mode: config.mode },
        "AISDKService initialized from database configuration"
      );
    } catch (error) {
      this.logger.warn(
        { error },
        "AISDKService initialization failed, user will be prompted to configure"
      );
    }
  }

  private initDatabaseService(): void {
    try {
      databaseService.initialize();
      this.logger.info("Database service initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize database service");
      throw error;
    }
  }

  private registerIPCHandlers(): void {
    if (isDev) {
      IPCHandlerRegistry.getInstance().unregisterAll();
      this.logger.debug("Cleaned up existing IPC handlers for hot reload");
    }

    registerI18nHandlers();
    registerLLMConfigHandlers();
    registerScreenCaptureHandlers();
    registerPermissionHandlers();
    registerCaptureSourceSettingsHandlers();
    registerUserSettingsHandlers();
    registerContextGraphHandlers();
    registerThreadsHandlers();
    registerUsageHandlers();
    registerActivityMonitorHandlers();
    registerMonitoringHandlers();
    registerAppHandlers();
    registerAppUpdateHandlers();
    registerNotificationHandlers();
    this.logger.info("IPC handlers registered");
  }

  private initPowerMonitor(): void {
    try {
      powerMonitorService.initialize();
      this.logger.info("Power monitor initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize power monitor");
    }
  }

  private async initMonitoringServer(): Promise<void> {
    if (!isDev) return;

    try {
      await monitoringServer.start();
      this.logger.info(
        { port: monitoringServer.getPort() },
        "Monitoring server auto-started in dev mode"
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to auto-start monitoring server");
    }
  }

  private createMainWindow(): BrowserWindow {
    const iconBase = app.isPackaged ? RENDERER_DIST : path.join(APP_ROOT, "public");
    const iconCandidates =
      process.platform === "win32"
        ? [path.join(iconBase, "logo.ico"), path.join(iconBase, "logo.png")]
        : [path.join(iconBase, "logo.png")];
    const appIconPath = iconCandidates.find((p) => existsSync(p)) ?? iconCandidates[0];
    const appIcon = nativeImage.createFromPath(appIconPath);

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    const windowWidth = Math.round(screenWidth * 0.8);
    const windowHeight = Math.round(screenHeight * 0.8);

    const win = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      show: true,
      title: app.getName(),
      icon: process.platform === "win32" ? appIconPath : appIcon,
      webPreferences: {
        preload: path.join(MAIN_DIST, "preload.mjs"),
      },
      autoHideMenuBar: true,
      titleBarStyle: process.platform === "darwin" ? "hidden" : "hidden",
      ...(process.platform === "darwin"
        ? {
            trafficLightPosition: {
              x: 12,
              y: 10,
            },
          }
        : {}),
      titleBarOverlay:
        process.platform === "win32"
          ? {
              color: "#00000000",
              symbolColor: "#999999",
              height: 36,
            }
          : false,
    });

    if (process.platform === "darwin" && app.dock && !app.isPackaged) {
      app.dock.setIcon(appIcon);
    }

    win.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });

    win.on("closed", () => {
      if (this.mainWindow === win) {
        this.mainWindow = null;
      }
    });

    win.webContents.on("did-finish-load", () => {
      win.setTitle(app.getName());
      win.webContents.send("main-process-message", new Date().toLocaleString());
    });

    // Load splash page initially
    const startUrl = VITE_DEV_SERVER_URL
      ? `${VITE_DEV_SERVER_URL}/splash`
      : `file://${path.join(RENDERER_DIST, "index.html")}#/splash`;

    void win.loadURL(startUrl);

    return win;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    TrayService.resetInstance();
    notificationService.dispose();
    captureScheduleController.stop();
    screenCaptureModule.dispose();
    powerMonitorService.dispose();
    appUpdateService.dispose();
    monitoringServer.stop();
    databaseService.close();
    this.trayService?.dispose();
  }
}

// ============================================================================
// App Lifecycle
// ============================================================================

if (gotTheLock) {
  const controller = new AppLifecycleController();
  if (!isDev) {
    app.on("second-instance", () => {
      controller.focusMainWindow();
    });
  }
  void controller.start();
}
