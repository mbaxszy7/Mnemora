/**
 * LLM Configuration IPC Handlers
 * Handles IPC communication for LLM configuration operations
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
import { IPC_CHANNELS } from "@shared/ipc-types";
import { LLMConfig, LLMConfigCheckResult, LLMValidationResult } from "@shared/llm-config-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { getLogger } from "../services/logger";

const logger = getLogger("llm-config-handlers");

export function registerLLMConfigHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  // Check if valid LLM configuration exists
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_CHECK,
    async (_event: Electron.IpcMainInvokeEvent): Promise<LLMConfigCheckResult> => {
      const { LLMConfigService } = await import("../services/llm-config-service");
      logger.debug("Handling LLM_CONFIG_CHECK");
      return LLMConfigService.getInstance().checkConfiguration();
    }
  );

  // Validate LLM configuration by testing API calls
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_VALIDATE,
    async (
      _event: Electron.IpcMainInvokeEvent,
      config: LLMConfig
    ): Promise<LLMValidationResult> => {
      const { LLMConfigService } = await import("../services/llm-config-service");
      logger.debug({ mode: config.mode }, "Handling LLM_CONFIG_VALIDATE");
      return LLMConfigService.getInstance().validateConfiguration(config);
    }
  );

  // Save LLM configuration to database
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_SAVE,
    async (_event: Electron.IpcMainInvokeEvent, config: LLMConfig): Promise<void> => {
      const [{ LLMConfigService }, { aiRuntimeService }] = await Promise.all([
        import("../services/llm-config-service"),
        import("../services/ai-runtime-service"),
      ]);
      logger.debug({ mode: config.mode }, "Handling LLM_CONFIG_SAVE");
      await LLMConfigService.getInstance().saveConfiguration(config);
      await aiRuntimeService.handleConfigSaved(config);
      return void 0;
    }
  );

  // Get LLM configuration from database
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_GET,
    async (_event: Electron.IpcMainInvokeEvent): Promise<LLMConfig | null> => {
      const { LLMConfigService } = await import("../services/llm-config-service");
      logger.debug("Handling LLM_CONFIG_GET");
      return LLMConfigService.getInstance().loadConfiguration();
    }
  );

  logger.info("LLM Config IPC handlers registered");
}
