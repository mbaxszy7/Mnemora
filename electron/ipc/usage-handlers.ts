import { IPC_CHANNELS, type UsageTimeRangePayload } from "../../shared/ipc-types";
import { llmUsageService } from "../services/usage/llm-usage-service";
import { getLogger } from "../services/logger";
import { IPCHandlerRegistry } from "./handler-registry";

const logger = getLogger("usage-handlers");

export function registerUsageHandlers() {
  const registry = IPCHandlerRegistry.getInstance();
  logger.info("Registering Usage IPC handlers");

  registry.registerHandler(
    IPC_CHANNELS.USAGE_GET_SUMMARY,
    async (_, payload: UsageTimeRangePayload) => {
      try {
        return {
          success: true,
          data: await llmUsageService.getUsageSummary(
            { fromTs: payload.fromTs, toTs: payload.toTs },
            payload.configHash
          ),
        };
      } catch (error) {
        logger.error({ error: String(error) }, "Failed to get usage summary");
        return {
          success: false,
          error: {
            code: "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.USAGE_GET_DAILY,
    async (_, payload: UsageTimeRangePayload) => {
      try {
        return {
          success: true,
          data: await llmUsageService.getDailyUsage(
            { fromTs: payload.fromTs, toTs: payload.toTs },
            payload.configHash
          ),
        };
      } catch (error) {
        logger.error({ error: String(error) }, "Failed to get daily usage");
        return {
          success: false,
          error: {
            code: "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  );

  registry.registerHandler(
    IPC_CHANNELS.USAGE_GET_BREAKDOWN,
    async (_, payload: UsageTimeRangePayload) => {
      try {
        return {
          success: true,
          data: await llmUsageService.getBreakdownByModel(
            { fromTs: payload.fromTs, toTs: payload.toTs },
            payload.configHash
          ),
        };
      } catch (error) {
        logger.error({ error: String(error) }, "Failed to get usage breakdown");
        return {
          success: false,
          error: {
            code: "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  );
}
