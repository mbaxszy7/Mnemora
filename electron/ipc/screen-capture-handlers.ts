/**
 * IPC Handlers for Screen Capture Scheduler
 *
 * Provides IPC channels for controlling the screen capture scheduler:
 * - start/stop/pause/resume
 * - getState
 * - updateConfig
 */

import { IPC_CHANNELS, IPCResult, toIPCError } from "@shared/ipc-types";
import type { SchedulerConfigPayload, SchedulerStatePayload } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { captureScheduleController, screenCaptureModule } from "../services/screen-capture";
import { userSettingService } from "../services/user-setting-service";
import { getLogger } from "../services/logger";

const logger = getLogger("screen-capture-handlers");

/**
 * Register all screen capture IPC handlers
 */
export function registerScreenCaptureHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  // Start scheduler
  registry.registerHandler(
    IPC_CHANNELS.SCREEN_CAPTURE_START,
    async (): Promise<IPCResult<void>> => {
      try {
        logger.info("IPC: Starting screen capture scheduler");
        await userSettingService.setCaptureManualOverride("force_on");
        await captureScheduleController.evaluateNow();
        return { success: true };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to start screen capture scheduler");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Stop scheduler
  registry.registerHandler(IPC_CHANNELS.SCREEN_CAPTURE_STOP, async (): Promise<IPCResult<void>> => {
    try {
      logger.info("IPC: Stopping screen capture scheduler");
      const module = screenCaptureModule;
      await userSettingService.setCaptureManualOverride("force_off");
      module.stop();
      return { success: true };
    } catch (error) {
      logger.error({ error }, "IPC: Failed to stop screen capture scheduler");
      return { success: false, error: toIPCError(error) };
    }
  });

  // Pause scheduler
  registry.registerHandler(
    IPC_CHANNELS.SCREEN_CAPTURE_PAUSE,
    async (): Promise<IPCResult<void>> => {
      try {
        logger.info("IPC: Pausing screen capture scheduler");
        const module = screenCaptureModule;
        module.pause();
        return { success: true };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to pause screen capture scheduler");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Resume scheduler
  registry.registerHandler(
    IPC_CHANNELS.SCREEN_CAPTURE_RESUME,
    async (): Promise<IPCResult<void>> => {
      try {
        logger.info("IPC: Resuming screen capture scheduler");
        await userSettingService.setCaptureManualOverride("force_on");
        await captureScheduleController.evaluateNow();
        return { success: true };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to resume screen capture scheduler");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Get scheduler state
  registry.registerHandler(
    IPC_CHANNELS.SCREEN_CAPTURE_GET_STATE,
    async (): Promise<IPCResult<SchedulerStatePayload>> => {
      try {
        const module = screenCaptureModule;
        const state = module.getState();
        return { success: true, data: state };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to get screen capture scheduler state");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Update scheduler configuration
  registry.registerHandler(
    IPC_CHANNELS.SCREEN_CAPTURE_UPDATE_CONFIG,
    async (_event, config: SchedulerConfigPayload): Promise<IPCResult<void>> => {
      try {
        logger.info({ config }, "IPC: Updating screen capture scheduler config");
        const module = screenCaptureModule;
        module.updateConfig(config);
        return { success: true };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to update screen capture scheduler config");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  // Initialize capture services
  registry.registerHandler(
    IPC_CHANNELS.CAPTURE_SOURCES_INIT_SERVICES,
    async (): Promise<IPCResult<boolean>> => {
      try {
        logger.info("Attempting to initialize capture services");
        const initialized = await screenCaptureModule.tryInitialize();
        return { success: true, data: initialized };
      } catch (error) {
        logger.error({ error }, "Failed to initialize capture services");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  logger.info("Screen capture IPC handlers registered");
}
