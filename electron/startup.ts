/**
 * Startup initialization module
 *
 * Contains early-stage initialization code that must run before the main app logic:
 * - Squirrel.Windows startup events (install/update/uninstall)
 * - Global error handlers
 * - Environment setup
 *
 * This module has side effects and should be imported at the very top of main.ts.
 */

import { app } from "electron";
import path from "node:path";
import { spawn } from "node:child_process";
import { APP_ROOT, VITE_PUBLIC } from "./env";
import { getLogger } from "./services/logger";

// ============================================================================
// Squirrel.Windows Startup Events (required for ARM64 install)
// ============================================================================
// Squirrel launches the app with --squirrel-* args during install/update/uninstall.
// The app must handle them (create/remove shortcuts) and exit immediately.
// Without this, the app fails to install properly on Windows ARM64.

export function handleSquirrelEvents(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

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
    if (!process.env.VITEST) {
      process.exit(0);
    }
    return true;
  }

  return false;
}

export function registerGlobalErrorHandlers(): void {
  process.on("uncaughtException", (error) => {
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
}

export function setupEnvironment(): void {
  process.env.APP_ROOT = process.env.APP_ROOT ?? APP_ROOT;
  process.env.VITE_PUBLIC = process.env.VITE_PUBLIC ?? VITE_PUBLIC;

  if (process.platform === "win32") {
    app.setAppUserModelId(app.getName());
  }
}

handleSquirrelEvents();
registerGlobalErrorHandlers();
setupEnvironment();
