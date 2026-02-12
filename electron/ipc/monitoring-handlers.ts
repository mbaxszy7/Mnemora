import { shell } from "electron";
import {
  IPC_CHANNELS,
  toIPCError,
  type IPCResult,
  type MonitoringOpenDashboardResult,
} from "@shared/ipc-types";
import { getLogger } from "../services/logger";
import { IPCHandlerRegistry } from "./handler-registry";

let _logger: ReturnType<typeof getLogger> | null = null;
function getMonitoringLogger() {
  if (!_logger) {
    _logger = getLogger("monitoring-handlers");
  }
  return _logger;
}

export function registerMonitoringHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();
  const logger = getMonitoringLogger();

  registry.registerHandler(
    IPC_CHANNELS.MONITORING_OPEN_DASHBOARD,
    async (): Promise<IPCResult<MonitoringOpenDashboardResult>> => {
      try {
        const { monitoringServer } = await import("../services/monitoring");
        await monitoringServer.start();
        const url = `http://127.0.0.1:${monitoringServer.getPort()}`;

        try {
          await shell.openExternal(url);
        } catch (error) {
          logger.warn({ error }, "Failed to open monitoring dashboard URL");
        }

        return { success: true, data: { url } };
      } catch (error) {
        logger.error({ error }, "Failed to open monitoring dashboard");
        return { success: false, error: toIPCError(error) };
      }
    }
  );

  logger.info("Monitoring IPC handlers registered");
}
