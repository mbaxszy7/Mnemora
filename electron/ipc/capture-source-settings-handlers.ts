/**
 * IPC Handlers for Capture Source Settings
 *
 * Provides IPC channels for managing capture source preferences:
 * - GET_SCREENS: Get available screens with thumbnails
 * - GET_APPS: Get active applications with icons
 * - GET_PREFERENCES: Get current capture preferences
 * - SET_PREFERENCES: Update capture preferences
 */

import { IPC_CHANNELS, IPCResult, toIPCError } from "@shared/ipc-types";
import type {
  GetScreensResponse,
  GetAppsResponse,
  PreferencesResponse,
  SetPreferencesRequest,
} from "@shared/capture-source-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { getScreenCaptureModule } from "../services/screen-capture";
import { getLogger } from "../services/logger";

const logger = getLogger("capture-source-settings-handlers");

/**
 * Register all capture source settings IPC handlers
 */
export function registerCaptureSourceSettingsHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  // GET_SCREENS: Get available screens with thumbnails
  registry.registerHandler(
    IPC_CHANNELS.CAPTURE_SOURCES_GET_SCREENS,
    async (): Promise<IPCResult<GetScreensResponse>> => {
      try {
        logger.debug("IPC: Getting screens with thumbnails");
        const captureService = getScreenCaptureModule().getCaptureService();
        const screens = await captureService.getCaptureScreenInfo();
        return { success: true, data: { screens } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to get screens");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // GET_APPS: Get active applications with icons
  registry.registerHandler(
    IPC_CHANNELS.CAPTURE_SOURCES_GET_APPS,
    async (): Promise<IPCResult<GetAppsResponse>> => {
      try {
        logger.debug("IPC: Getting active apps");
        const captureService = getScreenCaptureModule().getCaptureService();
        const apps = await captureService.getCaptureAppInfo();
        return { success: true, data: { apps } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to get apps");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // GET_PREFERENCES: Get current capture preferences
  registry.registerHandler(
    IPC_CHANNELS.CAPTURE_SOURCES_GET_PREFERENCES,
    async (): Promise<IPCResult<PreferencesResponse>> => {
      try {
        logger.debug("IPC: Getting capture preferences");
        const preferences = getScreenCaptureModule().getPreferencesService().getPreferences();
        return { success: true, data: { preferences } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to get preferences");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // SET_PREFERENCES: Update capture preferences
  registry.registerHandler(
    IPC_CHANNELS.CAPTURE_SOURCES_SET_PREFERENCES,
    async (_event, request: SetPreferencesRequest): Promise<IPCResult<PreferencesResponse>> => {
      try {
        const module = getScreenCaptureModule();
        module.setPreferences(request.preferences);
        const preferences = module.getPreferencesService().getPreferences();
        return { success: true, data: { preferences } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to set preferences");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  logger.info("Capture source settings IPC handlers registered");
}
