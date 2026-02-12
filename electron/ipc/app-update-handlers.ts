import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import type { CheckNowResult, AppUpdateStatus } from "@shared/app-update-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { getLogger } from "../services/logger";

const logger = getLogger("app-update-handlers");

async function getAppUpdateService() {
  const { appUpdateService } = await import("../services/app-update-service");
  return appUpdateService;
}

async function ensureUpdateInitialized() {
  const appUpdateService = await getAppUpdateService();
  appUpdateService.initialize({ autoCheck: false, startInterval: true });
  return appUpdateService;
}

export function registerAppUpdateHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(
    IPC_CHANNELS.APP_UPDATE_GET_STATUS,
    async (): Promise<IPCResult<AppUpdateStatus>> => {
      try {
        const appUpdateService = await getAppUpdateService();
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
        const appUpdateService = await ensureUpdateInitialized();
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
        const appUpdateService = await ensureUpdateInitialized();
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
        const appUpdateService = await ensureUpdateInitialized();
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
