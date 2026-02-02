import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import type {
  NotificationPreferencesResponse,
  NotificationPreferencesRequest,
  ShowNotificationRequest,
} from "@shared/notification-types";

import { IPCHandlerRegistry } from "./handler-registry";
import { notificationService } from "../services/notification/notification-service";
import { getLogger } from "../services/logger";

const logger = getLogger("notification-handlers");

export function registerNotificationHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(
    IPC_CHANNELS.NOTIFICATION_SHOW,
    async (_event, request: ShowNotificationRequest): Promise<IPCResult<void>> => {
      try {
        await notificationService.show(request.notification);
        return { success: true, data: undefined };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to show notification");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.NOTIFICATION_GET_PREFERENCES,
    async (): Promise<IPCResult<NotificationPreferencesResponse>> => {
      try {
        const preferences = await notificationService.refreshPreferences();
        return { success: true, data: { preferences } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to get notification preferences");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.NOTIFICATION_UPDATE_PREFERENCES,
    async (
      _event,
      request: NotificationPreferencesRequest
    ): Promise<IPCResult<NotificationPreferencesResponse>> => {
      try {
        const preferences = await notificationService.updatePreferences(request.preferences);
        return { success: true, data: { preferences } };
      } catch (error) {
        logger.error({ error }, "IPC: Failed to update notification preferences");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  logger.info("Notification IPC handlers registered");
}
