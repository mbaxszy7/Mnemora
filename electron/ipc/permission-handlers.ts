/**
 * IPC Handlers for Permission Management
 *
 * Provides IPC channels for checking and requesting system permissions.
 */

import { IPC_CHANNELS, IPCResult, toIPCError } from "@shared/ipc-types";
import type { PermissionCheckResult } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { permissionService } from "../services/permission-service";
import { getLogger } from "../services/logger";
import { app, BrowserWindow } from "electron";

// Lazy logger initialization to avoid issues with app not being ready
let _logger: ReturnType<typeof getLogger> | null = null;
function getPermissionLogger() {
  if (!_logger) {
    _logger = getLogger("permission-handlers");
  }
  return _logger;
}

let lastPermissionStatus: PermissionCheckResult | null = null;
let watcherInitialized = false;

function broadcastPermissionStatusChanged(next: PermissionCheckResult): void {
  if (
    lastPermissionStatus &&
    lastPermissionStatus.screenRecording === next.screenRecording &&
    lastPermissionStatus.accessibility === next.accessibility
  ) {
    return;
  }

  lastPermissionStatus = next;
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.PERMISSION_STATUS_CHANGED, next);
    }
  } catch {
    // Ignore if BrowserWindow is not available (e.g. tests)
  }
}

function refreshAndBroadcastPermissionStatus(): PermissionCheckResult {
  const next = permissionService.checkAllPermissions();
  broadcastPermissionStatusChanged(next);
  return next;
}

function ensurePermissionStatusWatcher(): void {
  if (watcherInitialized) return;
  watcherInitialized = true;

  const refresh = () => {
    try {
      refreshAndBroadcastPermissionStatus();
    } catch (error) {
      getPermissionLogger().warn({ error }, "Failed to refresh permission status");
    }
  };

  app.on("browser-window-focus", refresh);
  app.on("activate", refresh);

  refresh();
}

/**
 * Register all permission IPC handlers
 */
export function registerPermissionHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();
  const logger = getPermissionLogger();

  ensurePermissionStatusWatcher();

  // Check all permissions
  registry.registerHandler(
    IPC_CHANNELS.PERMISSION_CHECK,
    async (): Promise<IPCResult<PermissionCheckResult>> => {
      try {
        const result = refreshAndBroadcastPermissionStatus();
        logger.debug({ result }, "Permission check result");
        return { success: true, data: result };
      } catch (error) {
        logger.error({ error }, "Failed to check permissions");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Request screen recording permission
  registry.registerHandler(
    IPC_CHANNELS.PERMISSION_REQUEST_SCREEN_RECORDING,
    async (): Promise<IPCResult<boolean>> => {
      try {
        logger.info("Requesting screen recording permission");
        const granted = await permissionService.requestScreenRecordingPermission();
        refreshAndBroadcastPermissionStatus();
        return { success: true, data: granted };
      } catch (error) {
        logger.error({ error }, "Failed to request screen recording permission");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Request accessibility permission
  registry.registerHandler(
    IPC_CHANNELS.PERMISSION_REQUEST_ACCESSIBILITY,
    async (): Promise<IPCResult<boolean>> => {
      try {
        logger.info("Requesting accessibility permission");
        const granted = await permissionService.requestAccessibilityPermission();
        refreshAndBroadcastPermissionStatus();
        return { success: true, data: granted };
      } catch (error) {
        logger.error({ error }, "Failed to request accessibility permission");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Open system settings for screen recording
  registry.registerHandler(
    IPC_CHANNELS.PERMISSION_OPEN_SCREEN_RECORDING_SETTINGS,
    async (): Promise<IPCResult<void>> => {
      try {
        logger.info("Opening screen recording settings");
        await permissionService.openScreenRecordingPreferences();
        return { success: true };
      } catch (error) {
        logger.error({ error }, "Failed to open screen recording settings");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Open system settings for accessibility
  registry.registerHandler(
    IPC_CHANNELS.PERMISSION_OPEN_ACCESSIBILITY_SETTINGS,
    async (): Promise<IPCResult<void>> => {
      try {
        logger.info("Opening accessibility settings");
        await permissionService.openAccessibilityPreferences();
        return { success: true };
      } catch (error) {
        logger.error({ error }, "Failed to open accessibility settings");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  logger.info("Permission IPC handlers registered");
}
