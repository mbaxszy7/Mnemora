import { IPC_CHANNELS, IPCResult, toIPCError } from "@shared/ipc-types";
import type {
  SetCaptureManualOverrideRequest,
  SetOnboardingProgressRequest,
  UpdateUserSettingsRequest,
  UserSettingsResponse,
} from "@shared/user-settings-types";

import { IPCHandlerRegistry } from "./handler-registry";
import { userSettingService } from "../services/user-setting-service";
import { captureScheduleController } from "../services/screen-capture";
import { getLogger } from "../services/logger";

const logger = getLogger("user-settings-handlers");

export function registerUserSettingsHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(
    IPC_CHANNELS.USER_SETTINGS_GET,
    async (): Promise<IPCResult<UserSettingsResponse>> => {
      try {
        const settings = await userSettingService.getSettings();
        return { success: true, data: { settings } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to get user settings");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.USER_SETTINGS_UPDATE,
    async (
      _event,
      request: UpdateUserSettingsRequest
    ): Promise<IPCResult<UserSettingsResponse>> => {
      try {
        const settings = await userSettingService.updateSettings(request.settings);
        await captureScheduleController.evaluateNow();
        return { success: true, data: { settings } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to update user settings");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.USER_SETTINGS_SET_CAPTURE_OVERRIDE,
    async (
      _event,
      request: SetCaptureManualOverrideRequest
    ): Promise<IPCResult<UserSettingsResponse>> => {
      try {
        const settings = await userSettingService.setCaptureManualOverride(request.mode);
        await captureScheduleController.evaluateNow();
        return { success: true, data: { settings } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to set capture manual override");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.USER_SETTINGS_SET_ONBOARDING_PROGRESS,
    async (
      _event,
      request: SetOnboardingProgressRequest
    ): Promise<IPCResult<UserSettingsResponse>> => {
      try {
        const settings = await userSettingService.setOnboardingProgress(request.progress);
        return { success: true, data: { settings } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to set onboarding progress");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  logger.info("User settings IPC handlers registered");
}
