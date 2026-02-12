import { app, BrowserWindow, Menu, nativeImage, screen, ipcMain } from "electron";
import type Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { APP_ROOT, isDev, MAIN_DIST, RENDERER_DIST, VITE_DEV_SERVER_URL, VITE_PUBLIC } from "./env";
import { IPCHandlerRegistry } from "./ipc/handler-registry";
import { initializeLogger, getLogger } from "./services/logger";
import { ftsHealthService } from "./services/fts-health-service";
import type { BootMessageKey, BootPhase, BootStatus, IPCResult } from "../shared/ipc-types";

// All other imports (database, IPC handlers, services) are loaded lazily via
// dynamic import() to avoid blocking the main thread with native module loading
// (better-sqlite3, node-screenshots, sharp, etc.) before the splash window appears.

// ============================================================================
// Squirrel.Windows Startup Events (required for ARM64 install)
// ============================================================================
// Squirrel launches the app with --squirrel-* args during install/update/uninstall.
// The app must handle them (create/remove shortcuts) and exit immediately.
// Without this, the app fails to install properly on Windows ARM64.

if (process.platform === "win32") {
  const squirrelCommand = process.argv[1];
  if (
    squirrelCommand === "--squirrel-install" ||
    squirrelCommand === "--squirrel-updated" ||
    squirrelCommand === "--squirrel-uninstall" ||
    squirrelCommand === "--squirrel-obsolete"
  ) {
    const appFolder = path.dirname(process.execPath);
    const updateExe = path.resolve(appFolder, "..", "Update.exe");
    const exeName = path.basename(process.execPath);

    if (squirrelCommand === "--squirrel-install" || squirrelCommand === "--squirrel-updated") {
      spawn(updateExe, ["--createShortcut", exeName], { detached: true });
    } else if (squirrelCommand === "--squirrel-uninstall") {
      spawn(updateExe, ["--removeShortcut", exeName], { detached: true });
    }

    app.quit();
    process.exit(0);
  }
}

// ============================================================================
// Global Error Handlers (must be registered before anything else)
// ============================================================================

process.on("uncaughtException", (error) => {
  // In production the logger may not be ready yet, so fall back to stderr.
  // This prevents Electron from showing a crash dialog for non-fatal errors
  // such as tesseract.js Worker fetch failures on offline machines.
  try {
    const logger = getLogger("uncaught");
    logger.error({ error }, "Uncaught exception in main process");
  } catch {
    console.error("[uncaughtException]", error);
  }
});

process.on("unhandledRejection", (reason) => {
  try {
    const logger = getLogger("uncaught");
    logger.error({ reason }, "Unhandled promise rejection in main process");
  } catch {
    console.error("[unhandledRejection]", reason);
  }
});

// ============================================================================
// Environment Setup
// ============================================================================

process.env.APP_ROOT = process.env.APP_ROOT ?? APP_ROOT;
process.env.VITE_PUBLIC = process.env.VITE_PUBLIC ?? VITE_PUBLIC;

if (process.platform === "win32") {
  app.setAppUserModelId(app.getName());
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private trayService: any = null;
  private isQuitting = false;
  private started = false;
  private disposed = false;
  private latestBootStatus: BootStatus | null = null;
  private hasReachedTerminalState = false;
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
      "background-init": 95,
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
   * Optimized for fast startup: splits initialization into critical path
   * (blocking ready) and deferred path (background after UI visible).
   */
  private async runBootSequence(): Promise<void> {
    try {
      // Phase 1: Database initialization (critical - needed for all features)
      this.emitBootStatus("db-init");
      const { databaseService } = await import("./database");
      this.lazy.databaseService = databaseService;
      databaseService.initialize();
      this.logger.info("Database service initialized");

      // Register IPC handlers (dynamic import all handler modules in parallel)
      await this.registerIPCHandlers();

      // Phase 2: FTS5 quick check (lightweight - just verify table exists)
      // Deep health check and rebuild are deferred to background
      this.emitBootStatus("fts-check");
      const sqlite = databaseService.getSqlite();
      if (!sqlite) {
        throw new Error("Database not initialized");
      }

      // Quick check: table exists and has data? Skip to ready.
      // Full integrity check runs in background after UI is visible.
      const ftsQuickResult = await this.runQuickFtsCheck(sqlite);
      this.emitFtsHealth();

      // Emit ready immediately - UI can now interact
      // All non-critical services (user settings, i18n, tray, etc.) run in background
      const initialStatus = ftsQuickResult.isHealthy ? "ready" : "degraded";
      this.emitBootStatus(initialStatus, ftsQuickResult.error);

      // Phase 3: Deferred initialization (runs in background after UI visible)
      // This includes: FTS deep check/rebuild, AI init, screen capture, OCR warmup, etc.
      void this.runDeferredInitialization(sqlite);
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
   * Deferred initialization - runs in background after UI is visible
   * Non-blocking: failures here don't prevent app usage
   */
  private async runDeferredInitialization(sqlite: Database.Database): Promise<void> {
    this.logger.info("Starting deferred initialization...");

    try {
      this.emitBootStatus("background-init");

      // 1. Run full FTS health check and rebuild if needed (background)
      const ftsResult = await ftsHealthService.runStartupCheckAndHeal(sqlite, () => {
        this.emitBootStatus("fts-rebuild");
      });
      this.emitFtsHealth();

      // Update status based on deep check result
      if (ftsResult.status === "healthy") {
        this.emitBootStatus("ready");
      } else if (ftsResult.status === "degraded") {
        this.emitBootStatus("degraded", {
          code: ftsResult.errorCode || "FTS_UNHEALTHY",
          message: ftsResult.error || "FTS5 is unavailable",
        });
      }

      // 2. Initialize non-critical services in parallel
      await this.initializeDeferredServices();

      this.logger.info("Deferred initialization completed");
    } catch (error) {
      this.logger.error({ error }, "Deferred initialization failed (non-fatal)");
    }
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
   * Initialize deferred services that can run in background after UI is visible.
   * Non-blocking: failures here don't prevent app usage.
   */
  private async initializeDeferredServices(): Promise<void> {
    // User settings (needed for capture schedule evaluation, not for splash)
    const { userSettingService } = await import("./services/user-setting-service");
    await userSettingService.getSettings();

    // Main-process i18n (only needed for tray menu text, not splash screen)
    await this.initI18nService();

    // Tray icon + menu (users won't notice a sub-second delay)
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

    // App auto-updater (network calls, not needed during splash)
    const { appUpdateService } = await import("./services/app-update-service");
    this.lazy.appUpdateService = appUpdateService;
    appUpdateService.initialize();

    // Initialize screen capture (can be deferred - not needed immediately)
    const { captureScheduleController, screenCaptureModule } =
      await import("./services/screen-capture");
    this.lazy.captureScheduleController = captureScheduleController;
    this.lazy.screenCaptureModule = screenCaptureModule;
    captureScheduleController.initialize({ screenCapture: screenCaptureModule });
    captureScheduleController.start();

    // Notification subscriptions (non-critical)
    const { notificationService } = await import("./services/notification/notification-service");
    this.lazy.notificationService = notificationService;
    notificationService.registerEventBusSubscriptions();

    // AI service initialization (may involve network calls - defer)
    await this.initAIService();

    // Power monitor (non-critical for UI)
    await this.initPowerMonitor();

    // Monitoring server (dev only)
    await this.initMonitoringServer();

    // OCR warmup (always non-blocking)
    void this.tryWarmupOcrService();
  }

  private async tryWarmupOcrService(): Promise<void> {
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
    try {
      const { mainI18n } = await import("./services/i18n-service");
      await mainI18n.initialize();
      this.logger.info("i18n service initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize i18n service");
    }
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
    try {
      const { powerMonitorService } = await import("./services/power-monitor");
      this.lazy.powerMonitorService = powerMonitorService;
      powerMonitorService.initialize();
      this.logger.info("Power monitor initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize power monitor");
    }
  }

  private async initMonitoringServer(): Promise<void> {
    if (!isDev) return;

    try {
      const { monitoringServer } = await import("./services/monitoring");
      this.lazy.monitoringServer = monitoringServer;
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
