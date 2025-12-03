import { app, BrowserWindow } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AISDKService } from "./services/ai-sdk-service";
import { registerVLMHandlers } from "./ipc/vlm-handlers";
import { registerI18nHandlers } from "./ipc/i18n-handlers";
import { IPCHandlerRegistry } from "./ipc/handler-registry";
import { initializeLogger, getLogger } from "./services/logger";
import { mainI18n } from "./services/i18n-service";

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

// ============================================================================
// Logger Initialization
// ============================================================================

initializeLogger();
const logger = getLogger("main");

// ============================================================================
// Window Management
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-unused-vars
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, "logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
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
  await mainI18n.initialize();
  logger.info("i18n service initialized");
}

function initAIService(): void {
  const aiService = AISDKService.getInstance();
  aiService.initialize({
    name: "MOONSHOT",
    baseURL: "https://api.moonshot.cn/v1",
    model: "kimi-latest",
    apiKey: "sk-mvcB7z8Kgln2zzEWf8V7FRVAdX8nIy09BsySNb1S4CnR9Vsg",
  });
  logger.info("AI SDK service initialized");
}

function registerIPCHandlers(): void {
  // Clean up existing handlers for hot reload (dev mode only)
  if (isDev) {
    IPCHandlerRegistry.getInstance().unregisterAll();
    logger.debug("Cleaned up existing IPC handlers for hot reload");
  }

  registerI18nHandlers();
  registerVLMHandlers();
  logger.info("IPC handlers registered");
}

async function initializeApp(): Promise<void> {
  // 1. Register IPC handlers first (before any async operations)
  registerIPCHandlers();

  // 2. Initialize i18n (required before UI)
  try {
    await initI18nService();
  } catch (error) {
    logger.error({ error }, "Failed to initialize i18n service");
  }

  // 3. Initialize AI service (non-critical, can fail gracefully)
  try {
    initAIService();
  } catch (error) {
    logger.warn({ error }, "AI service initialization failed");
  }
}

// ============================================================================
// App Lifecycle
// ============================================================================

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    mainWindow = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});

app.whenReady().then(async () => {
  await initializeApp();
  mainWindow = createMainWindow();
});
