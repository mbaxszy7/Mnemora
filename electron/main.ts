import { app, BrowserWindow, Menu, nativeImage, screen } from "electron";
import { createRequire } from "node:module";
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

// ============================================================================
// Environment Setup
// ============================================================================

const require = createRequire(import.meta.url);

process.env.APP_ROOT = process.env.APP_ROOT ?? APP_ROOT;
process.env.VITE_PUBLIC = process.env.VITE_PUBLIC ?? VITE_PUBLIC;

if (process.platform === "win32") {
  // Windows toast header (and icon association) is based on AppUserModelID.
  // In dev, if no Start Menu shortcut exists, Windows may display the raw AUMID string.
  // Use a friendly ID in dev so it shows "Mnemora" instead of "com.mnemora.app".
  app.setAppUserModelId(app.isPackaged ? "com.mnemora.app" : "Mnemora");
}

// ============================================================================
// Single Instance Lock (production only)
// ============================================================================

// Skip single instance lock in dev mode to allow HMR to restart Electron
const gotTheLock = isDev ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
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

  focusMainWindow(): void {
    const win = this.mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    // app.on("window-all-closed", () => {
    //   // Keep app running in tray; do not quit on window closed
    // });

    app.on("before-quit", () => {
      this.isQuitting = true;
      this.dispose();
    });

    app.on("activate", () => {
      // macOS: Show existing window or create new one when dock icon is clicked
      if (this.mainWindow) {
        this.mainWindow.show();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        this.mainWindow = this.createMainWindow();
      }
    });

    await app.whenReady();
    Menu.setApplicationMenu(null);

    initializeLogger();
    this.logger = getLogger("main");
    this.logger.info("App is ready, initializing...");

    this.initAutoUpdate();
    await this.initializeApp();

    this.mainWindow = this.createMainWindow();
    this.warmupOcrOnSplash();
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
    this.logger.info("Main window created");
  }

  private initAutoUpdate(): void {
    if (!app.isPackaged || process.platform !== "win32") {
      return;
    }

    try {
      const mod = require("update-electron-app");
      const updateElectronApp =
        mod?.updateElectronApp ?? mod?.default?.updateElectronApp ?? mod?.default ?? mod;

      if (typeof updateElectronApp !== "function") {
        this.logger.warn("update-electron-app is installed but did not export updateElectronApp()");
        return;
      }

      updateElectronApp({ owner: "mbaxszy7", repo: "Mnemora" });
      this.logger.info("Auto-update initialized (Windows packaged app)");
    } catch (error) {
      this.logger.warn({ error }, "Auto-update not initialized (missing dependency or misconfig)");
    }
  }

  private warmupOcrOnSplash(): void {
    setTimeout(() => {
      void this.tryWarmupOcrService();
    }, 0);
  }

  private async tryWarmupOcrService(): Promise<void> {
    try {
      await screenshotProcessingModule.ocrWarmup();
    } catch (error) {
      this.logger.warn({ error }, "Failed to warm up OCR service");
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

    // Calculate 80% of primary screen size
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    const windowWidth = Math.round(screenWidth * 0.8);
    const windowHeight = Math.round(screenHeight * 0.8);

    const win = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      show: true,
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

    // Set dock icon on macOS in development (packaged apps use the bundle icon).
    if (process.platform === "darwin" && app.dock && !app.isPackaged) {
      app.dock.setIcon(appIcon);
    }

    // All platforms: hide window instead of closing when user clicks close button
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
      win.webContents.send("main-process-message", new Date().toLocaleString());
    });

    if (VITE_DEV_SERVER_URL) {
      win.loadURL(VITE_DEV_SERVER_URL);
    } else {
      win.loadFile(path.join(RENDERER_DIST, "index.html"));
    }

    return win;
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
      throw error; // Database is critical, rethrow to prevent app start
    }
  }

  private registerIPCHandlers(): void {
    // Clean up existing handlers for hot reload (dev mode only)
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

  private async initializeApp(): Promise<void> {
    // 1. Register IPC handlers first (before any async operations)
    this.registerIPCHandlers();
    // 2. Initialize database (critical, must succeed)
    this.initDatabaseService();
    await userSettingService.getSettings();
    captureScheduleController.initialize({ screenCapture: screenCaptureModule });
    captureScheduleController.start();
    // 3. Initialize i18n (required before UI)
    await this.initI18nService();
    notificationService.registerEventBusSubscriptions();
    // 4. Initialize AI service from database (non-critical, can fail gracefully)
    await this.initAIService();
    // 5. Initialize power monitor (non-critical)
    this.initPowerMonitor();
    // 6. Initialize monitoring server (dev only)
    await this.initMonitoringServer();
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    TrayService.resetInstance();
    notificationService.dispose();
    captureScheduleController.stop();
    screenCaptureModule.dispose();
    powerMonitorService.dispose();
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
    // Handle second instance launch - focus existing window (production only)
    app.on("second-instance", () => {
      controller.focusMainWindow();
    });
  }
  void controller.start();
}
