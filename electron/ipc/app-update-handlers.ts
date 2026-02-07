import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import type { CheckNowResult, AppUpdateStatus } from "@shared/app-update-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { appUpdateService } from "../services/app-update-service";
import { getLogger } from "../services/logger";

const logger = getLogger("app-update-handlers");

export function registerAppUpdateHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(
    IPC_CHANNELS.APP_UPDATE_GET_STATUS,
    async (): Promise<IPCResult<AppUpdateStatus>> => {
      try {
        return { success: true, data: appUpdateService.getStatus() };
      } catch (error) {
        logger.error({ error }, "IPC: failed to get app update status");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.APP_UPDATE_CHECK_NOW,
    async (): Promise<IPCResult<CheckNowResult>> => {
      try {
        const started = await appUpdateService.checkNow();
        return { success: true, data: { started } };
      } catch (error) {
        logger.error({ error }, "IPC: failed to check update");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.APP_UPDATE_RESTART_AND_INSTALL,
    async (): Promise<IPCResult<void>> => {
      try {
        appUpdateService.restartAndInstall();
        return { success: true };
      } catch (error) {
        logger.error({ error }, "IPC: failed to restart and install");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.APP_UPDATE_OPEN_DOWNLOAD_PAGE,
    async (): Promise<IPCResult<{ url: string }>> => {
      try {
        const result = await appUpdateService.openDownloadPage();
        return { success: true, data: result };
      } catch (error) {
        logger.error({ error }, "IPC: failed to open download page");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  logger.info("App update IPC handlers registered");
}
