import { app, BrowserWindow, Menu, nativeImage, screen, ipcMain } from "electron";
import type Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";
// Startup initialization (Squirrel events, error handlers, env setup)
// Import must be at the top before any other app logic
import "./startup";
import { isDev, MAIN_DIST, RENDERER_DIST, VITE_DEV_SERVER_URL, APP_ROOT } from "./env";
import { IPCHandlerRegistry } from "./ipc/handler-registry";
import { initializeLogger, getLogger } from "./services/logger";
import type { BootMessageKey, BootPhase, BootStatus, IPCResult } from "../shared/ipc-types";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private trayService: any = null;
  private isQuitting = false;
  private started = false;
  private disposed = false;
  private latestBootStatus: BootStatus | null = null;
  private hasReachedTerminalState = false;
  private trayInitialized = false;
  // Lazily loaded service references (populated during boot, used by dispose)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lazy: Record<string, any> = {};

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

    await this.createAndBoot();
  }

  /**
   * Create window and start boot sequence
   */
  private async createAndBoot(): Promise<void> {
    // 1. Create main window immediately (showing splash)
    this.trayInitialized = false;
    this.mainWindow = this.createMainWindow();

    // 2. Register boot-related IPC handlers
    this.registerBootHandlers();

    // 3. Run boot sequence in background (all heavy modules loaded lazily)
    void this.runBootSequence();
  }

  /**
   * Register IPC handlers for boot status
   */
  private registerBootHandlers(): void {
    // Guard against double-registration (macOS activate can re-enter createAndBoot)
    ipcMain.removeHandler("boot:get-status");
    ipcMain.removeHandler("boot:retry-fts-repair");
    ipcMain.removeHandler("boot:relaunch");
    ipcMain.handle("boot:get-status", () => this.getCurrentBootStatus());
    ipcMain.handle("boot:retry-fts-repair", () => this.handleRetryFtsRepair());
    ipcMain.handle("boot:relaunch", () => this.handleRelaunch());
  }

  /**
   * Relaunch the entire application (main + renderer).
   * Used as a last-resort retry when the boot sequence has failed.
   */
  private handleRelaunch(): void {
    this.logger.info("Relaunch requested from renderer");
    app.relaunch();
    app.exit(0);
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
   * Prevents state regression: once terminal state (ready/degraded) is reached,
   * non-terminal states are ignored to avoid UI confusion
   */
  private emitBootStatus(phase: BootPhase, error?: { code: string; message: string }): void {
    const terminalStates: BootPhase[] = ["ready", "degraded", "failed"];
    const isTerminal = terminalStates.includes(phase);

    if (this.hasReachedTerminalState && !isTerminal) {
      this.logger.debug({ phase }, "Ignoring non-terminal state after reaching terminal state");
      return;
    }

    if (isTerminal) {
      this.hasReachedTerminalState = true;
    }

    const progress = this.getPhaseProgress(phase);
    const status: BootStatus = {
      phase,
      progress,
      messageKey: this.getPhaseI18nKey(phase),
      timestamp: Date.now(),
      ...(error && { errorCode: error.code, errorMessage: error.message }),
    };

    this.latestBootStatus = status;
    this.logger.info({ phase, progress }, "Boot status changed");

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("boot:status-changed", status);
    }
  }

  /**
   * Get progress for a boot phase
   */
  private getPhaseProgress(phase: BootPhase): number {
    const progressMap: Record<BootPhase, number> = {
      "db-init": 15,
      "fts-check": 35,
      "fts-rebuild": 55,
      "app-init": 75,
      "background-init": 90,
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
      "background-init": "boot.phase.backgroundInit",
      ready: "boot.phase.ready",
      degraded: "boot.phase.degraded",
      failed: "boot.phase.failed",
    };
    return keyMap[phase];
  }

  /**
   * Run the boot sequence
   *
   * Startup policy:
   * 1) show splash immediately
   * 2) initialize all core/deferred services while splash is visible
   * 3) emit terminal ready/degraded once initialization finishes
   */
  private async runBootSequence(): Promise<void> {
    try {
      // Phase 1: register handlers + database
      this.emitBootStatus("db-init");
      await this.registerIPCHandlers();

      const { databaseService } = await import("./database");
      this.lazy.databaseService = databaseService;
      databaseService.initialize();
      this.logger.info("Database service initialized");

      // Phase 2: quick FTS availability check
      this.emitBootStatus("fts-check");
      const sqlite = databaseService.getSqlite();
      if (!sqlite) {
        throw new Error("Database not initialized");
      }

      const ftsQuickResult = await this.runQuickFtsCheck(sqlite);
      await this.emitFtsHealth();

      // Phase 3: all deferred initialization runs while splash is visible
      this.emitBootStatus("app-init");
      const deferredResult = await this.runDeferredInitialization(sqlite);

      const finalError = ftsQuickResult.error ?? deferredResult.error;
      if (ftsQuickResult.isHealthy && deferredResult.isHealthy) {
        this.emitBootStatus("ready");
      } else {
        this.emitBootStatus("degraded", finalError);
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
   * Quick FTS check - runs synchronously during boot
   * Only checks table existence, defers integrity check to background
   */
  private async runQuickFtsCheck(sqlite: Database.Database): Promise<{
    isHealthy: boolean;
    error?: { code: string; message: string };
  }> {
    try {
      // Quick check: does table exist?
      const tableExists = sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screenshots_fts'")
        .get();

      if (!tableExists) {
        // New user - table will be created by migrations, mark as healthy
        return { isHealthy: true };
      }

      // For existing users, defer deep check to background
      // Return optimistic healthy status for fast startup
      return { isHealthy: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: message }, "Quick FTS check failed");
      return {
        isHealthy: false,
        error: { code: "FTS_QUICK_CHECK_FAILED", message },
      };
    }
  }

  /**
   * Deferred initialization while splash is visible.
   */
  private async runDeferredInitialization(sqlite: Database.Database): Promise<{
    isHealthy: boolean;
    error?: { code: string; message: string };
  }> {
    this.logger.info("Starting deferred initialization...");
    this.emitBootStatus("background-init");

    let error: { code: string; message: string } | undefined;

    // 1) Deep FTS health check / rebuild
    const ftsHealthService = await this.getFtsHealthService();
    const ftsResult = await ftsHealthService.runStartupCheckAndHeal(sqlite, () => {
      this.emitBootStatus("fts-rebuild");
    });
    await this.emitFtsHealth();

    if (ftsResult.status === "degraded") {
      error = {
        code: ftsResult.errorCode || "FTS_UNHEALTHY",
        message: ftsResult.error || "FTS5 is unavailable",
      };
    }

    // 2) Initialize remaining services
    const initFailures = await this.initializeDeferredServices();
    if (!error && initFailures.length > 0) {
      error = {
        code: "DEFERRED_INIT_FAILED",
        message: initFailures[0],
      };
    }

    if (error) {
      this.logger.warn({ error, initFailures }, "Deferred initialization completed with issues");
      return { isHealthy: false, error };
    }

    this.logger.info("Deferred initialization completed");
    return { isHealthy: true };
  }

  /**
   * Handle manual FTS repair retry
   */
  private async handleRetryFtsRepair(): Promise<IPCResult<{ success: boolean; error?: string }>> {
    try {
      const sqlite = this.lazy.databaseService?.getSqlite();
      if (!sqlite) {
        return { success: true, data: { success: false, error: "Database not available" } };
      }

      const ftsHealthService = await this.getFtsHealthService();
      const result = await ftsHealthService.retryRepair(sqlite, () => {
        this.emitBootStatus("fts-rebuild");
      });
      await this.emitFtsHealth();

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

  private async initializeDeferredServices(): Promise<string[]> {
    const failures: string[] = [];

    const runTask = async (name: string, task: () => Promise<void>) => {
      try {
        await task();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${name}: ${message}`);
        this.logger.error({ error }, `${name} initialization failed`);
      }
    };

    // Precondition for capture/update/runtime services
    await runTask("User settings", async () => {
      const { userSettingService } = await import("./services/user-setting-service");
      await userSettingService.getSettings();
    });

    // Initialize i18n first (required by Tray menu)
    await runTask("i18n", () => this.initI18nService());

    await Promise.all([
      runTask("Tray", () => this.initTrayService()),
      runTask("App update", () => this.initAppUpdateService()),
      runTask("Screen capture", () => this.initScreenCaptureService()),
      runTask("Notification", () => this.initNotificationService()),
      runTask("AI runtime", () => this.initAIService()),
      runTask("Power monitor", () => this.initPowerMonitor()),
      runTask("Monitoring server", () => this.initMonitoringServer()),
      runTask("OCR warmup", () => this.tryWarmupOcrService()),
    ]);

    return failures;
  }

  private async tryWarmupOcrService(): Promise<void> {
    const ftsHealthService = await this.getFtsHealthService();
    if (!ftsHealthService.isFtsUsable()) {
      this.logger.info("Skipping OCR warmup - FTS is not usable");
      return;
    }

    try {
      const { screenshotProcessingModule } =
        await import("./services/screenshot-processing/screenshot-processing-module");
      await screenshotProcessingModule.ocrWarmup();
    } catch (error) {
      this.logger.warn({ error }, "Failed to warm up OCR service");
    }
  }

  private async initI18nService(): Promise<void> {
    const { mainI18n } = await import("./services/i18n-service");
    await mainI18n.initialize();
    this.logger.info("i18n service initialized");
  }

  private async initTrayService(): Promise<void> {
    const { TrayService } = await import("./services/tray-service");
    this.lazy.TrayService = TrayService;
    this.trayService = TrayService.getInstance();
    this.trayService.configure({
      createWindow: () => {
        this.mainWindow = this.createMainWindow();
        return this.mainWindow;
      },
      getMainWindow: () => this.mainWindow,
      onQuit: () => {
        this.isQuitting = true;
        app.quit();
      },
    });
    this.trayService.init();
    this.trayService.refresh();
    this.trayInitialized = true;
    this.logger.info("Tray service initialized");
  }

  private async initAppUpdateService(): Promise<void> {
    const { appUpdateService } = await import("./services/app-update-service");
    this.lazy.appUpdateService = appUpdateService;
    appUpdateService.initialize();
    this.logger.info("App update service initialized");
  }

  private async initScreenCaptureService(): Promise<void> {
    const { captureScheduleController, screenCaptureModule } =
      await import("./services/screen-capture");
    this.lazy.captureScheduleController = captureScheduleController;
    this.lazy.screenCaptureModule = screenCaptureModule;
    captureScheduleController.initialize({ screenCapture: screenCaptureModule });
    captureScheduleController.start();
    this.logger.info("Screen capture service initialized");
  }

  private async initNotificationService(): Promise<void> {
    const { notificationService } = await import("./services/notification/notification-service");
    this.lazy.notificationService = notificationService;
    notificationService.registerEventBusSubscriptions();
    this.logger.info("Notification service initialized");
  }

  private async initAIService(): Promise<void> {
    try {
      const { LLMConfigService } = await import("./services/llm-config-service");
      const config = await LLMConfigService.getInstance().loadConfiguration();

      if (!config) {
        this.logger.info("No LLM configuration found in database, AISDKService not initialized");
        return;
      }

      const { AISDKService } = await import("./services/ai-sdk-service");
      AISDKService.getInstance().initialize(config);
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

  private async registerIPCHandlers(): Promise<void> {
    if (isDev) {
      IPCHandlerRegistry.getInstance().unregisterAll();
      this.logger.debug("Cleaned up existing IPC handlers for hot reload");
    }

    // Dynamic import all handler registrars in parallel
    const [
      { registerI18nHandlers },
      { registerLLMConfigHandlers },
      { registerScreenCaptureHandlers },
      { registerPermissionHandlers },
      { registerCaptureSourceSettingsHandlers },
      { registerUserSettingsHandlers },
      { registerContextGraphHandlers },
      { registerThreadsHandlers },
      { registerUsageHandlers },
      { registerActivityMonitorHandlers },
      { registerMonitoringHandlers },
      { registerAppHandlers },
      { registerAppUpdateHandlers },
      { registerNotificationHandlers },
    ] = await Promise.all([
      import("./ipc/i18n-handlers"),
      import("./ipc/llm-config-handlers"),
      import("./ipc/screen-capture-handlers"),
      import("./ipc/permission-handlers"),
      import("./ipc/capture-source-settings-handlers"),
      import("./ipc/user-settings-handlers"),
      import("./ipc/context-graph-handlers"),
      import("./ipc/threads-handlers"),
      import("./ipc/usage-handlers"),
      import("./ipc/activity-monitor-handlers"),
      import("./ipc/monitoring-handlers"),
      import("./ipc/app-handlers"),
      import("./ipc/app-update-handlers"),
      import("./ipc/notification-handlers"),
    ]);

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

  private async initPowerMonitor(): Promise<void> {
    const { powerMonitorService } = await import("./services/power-monitor");
    this.lazy.powerMonitorService = powerMonitorService;
    powerMonitorService.initialize();
    this.logger.info("Power monitor initialized");
  }

  private async initMonitoringServer(): Promise<void> {
    if (!isDev) return;

    const { monitoringServer } = await import("./services/monitoring");
    this.lazy.monitoringServer = monitoringServer;
    await monitoringServer.start();
    this.logger.info(
      { port: monitoringServer.getPort() },
      "Monitoring server auto-started in dev mode"
    );
  }

  private async getFtsHealthService(): Promise<
    (typeof import("./services/fts-health-service"))["ftsHealthService"]
  > {
    if (!this.lazy.ftsHealthService) {
      const { ftsHealthService } = await import("./services/fts-health-service");
      this.lazy.ftsHealthService = ftsHealthService;
    }
    return this.lazy.ftsHealthService;
  }

  private async emitFtsHealth(): Promise<void> {
    const ftsHealthService = await this.getFtsHealthService();
    const health = ftsHealthService.getDetails();

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("boot:fts-health-changed", health);
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
        if (this.trayInitialized) {
          win.hide();
        } else {
          win.minimize();
        }
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

    this.lazy.TrayService?.resetInstance();
    this.lazy.notificationService?.dispose();
    this.lazy.captureScheduleController?.stop();
    this.lazy.screenCaptureModule?.dispose();
    this.lazy.powerMonitorService?.dispose();
    this.lazy.appUpdateService?.dispose();
    this.lazy.monitoringServer?.stop();
    this.lazy.databaseService?.close();
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
