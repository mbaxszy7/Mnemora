import { app, BrowserWindow, nativeImage } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AISDKService } from "./services/ai-sdk-service";
import { LLMConfigService } from "./services/llm-config-service";
import { registerVLMHandlers } from "./ipc/vlm-handlers";
import { registerI18nHandlers } from "./ipc/i18n-handlers";
import { registerLLMConfigHandlers } from "./ipc/llm-config-handlers";
import { registerScreenCaptureHandlers } from "./ipc/screen-capture-handlers";
import { registerPermissionHandlers } from "./ipc/permission-handlers";
import { registerCaptureSourceSettingsHandlers } from "./ipc/capture-source-settings-handlers";
import { registerContextGraphHandlers } from "./ipc/context-graph-handlers";
import { registerUsageHandlers } from "./ipc/usage-handlers";
import { IPCHandlerRegistry } from "./ipc/handler-registry";
import { initializeLogger, getLogger } from "./services/logger";
import { mainI18n } from "./services/i18n-service";
import { databaseService } from "./database";
import { ScreenCaptureModule } from "./services/screen-capture";
import { powerMonitorService } from "./services/power-monitor";
import { TrayService } from "./services/tray-service";

// ============================================================================
// Environment Setup
// ============================================================================

void createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, "..");
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

const isDev = !!VITE_DEV_SERVER_URL;

// App icon path (for BrowserWindow and Dock)
const appIconPath = path.join(
  VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST,
  "logo.png"
);

// ============================================================================
// Single Instance Lock (production only)
// ============================================================================

// Skip single instance lock in dev mode to allow HMR to restart Electron
const gotTheLock = isDev ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
} else if (!isDev) {
  // Handle second instance launch - focus existing window (production only)
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============================================================================
// Window Management
// ============================================================================

let mainWindow: BrowserWindow | null = null;
let logger: ReturnType<typeof getLogger>;
let trayService: TrayService | null = null;

function createMainWindow(): BrowserWindow {
  // Create native image for icon to prevent flashing
  const appIcon = nativeImage.createFromPath(appIconPath);

  const win = new BrowserWindow({
    show: true,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
  });

  // Set dock icon on macOS (persistent)
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }

  // All platforms: hide window instead of closing when user clicks close button
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    mainWindow = null;
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

// ============================================================================
// Service Initialization
// ============================================================================

async function initI18nService(): Promise<void> {
  try {
    await mainI18n.initialize();
    logger.info("i18n service initialized");
  } catch (error) {
    logger.error({ error }, "Failed to initialize i18n service");
  }
}
async function initAIService(): Promise<void> {
  try {
    const llmConfigService = LLMConfigService.getInstance();
    const config = await llmConfigService.loadConfiguration();

    if (!config) {
      logger.info("No LLM configuration found in database, AISDKService not initialized");
      return;
    }

    const aiService = AISDKService.getInstance();
    aiService.initialize(config);
    logger.info({ mode: config.mode }, "AISDKService initialized from database configuration");
  } catch (error) {
    logger.warn(
      { error },
      "AISDKService initialization failed, user will be prompted to configure"
    );
  }
}
function initDatabaseService(): void {
  try {
    databaseService.initialize();
    logger.info("Database service initialized");
  } catch (error) {
    logger.error({ error }, "Failed to initialize database service");
    throw error; // Database is critical, rethrow to prevent app start
  }
}
function registerIPCHandlers(): void {
  // Clean up existing handlers for hot reload (dev mode only)
  if (isDev) {
    IPCHandlerRegistry.getInstance().unregisterAll();
    logger.debug("Cleaned up existing IPC handlers for hot reload");
  }

  registerI18nHandlers();
  registerVLMHandlers();
  registerLLMConfigHandlers();
  registerScreenCaptureHandlers();
  registerPermissionHandlers();
  registerCaptureSourceSettingsHandlers();
  registerContextGraphHandlers();
  registerUsageHandlers();
  logger.info("IPC handlers registered");
}

/**
 * Initialize the power monitor service
 * Sets up system power event listeners
 */
function initPowerMonitor(): void {
  try {
    powerMonitorService.initialize();
    logger.info("Power monitor initialized");
  } catch (error) {
    logger.error({ error }, "Failed to initialize power monitor");
  }
}

async function initializeApp(): Promise<void> {
  // 1. Register IPC handlers first (before any async operations)
  registerIPCHandlers();
  // 2. Initialize database (critical, must succeed)
  initDatabaseService();
  // 3. Initialize i18n (required before UI)
  await initI18nService();
  // 4. Initialize AI service from database (non-critical, can fail gracefully)
  await initAIService();
  // 5. Initialize power monitor (non-critical)
  initPowerMonitor();
  // 6. Initialize screen capture module (only if permission granted)
  if (isDev) {
    ScreenCaptureModule.resetInstance();
  }
}

// ============================================================================
// App Lifecycle
// ============================================================================

// Flag to track if app is quitting (for macOS window management)
let isQuitting = false;

app.on("window-all-closed", () => {
  // Keep app running in tray; do not quit on window closed
});

app.on("before-quit", () => {
  // Set flag to allow window to actually close
  isQuitting = true;
  TrayService.resetInstance();
  // Dispose screen capture module after tray cleanup
  ScreenCaptureModule.disable();
  // Dispose power monitor
  powerMonitorService.dispose();
  // Close database connection before quitting
  databaseService.close();
  trayService?.dispose();
});

app.on("activate", () => {
  // macOS: Show existing window or create new one when dock icon is clicked
  if (mainWindow) {
    mainWindow.show();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});

if (gotTheLock) {
  app.whenReady().then(async () => {
    // Initialize logger after app is ready
    initializeLogger();
    logger = getLogger("main");
    logger.info("App is ready, initializing...");

    await initializeApp();
    mainWindow = createMainWindow();
    trayService = TrayService.getInstance();
    trayService
      .configure({
        createWindow: () => {
          mainWindow = createMainWindow();
          return mainWindow;
        },
        getMainWindow: () => mainWindow,
        onQuit: () => {
          isQuitting = true;
          app.quit();
        },
      })
      .init();
    logger.info("Main window created");
  });
}
