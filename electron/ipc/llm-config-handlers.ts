/**
 * LLM Configuration IPC Handlers
 * Handles IPC communication for LLM configuration operations
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
import { IPC_CHANNELS } from "@shared/ipc-types";
import { LLMConfig, LLMConfigCheckResult, LLMValidationResult } from "@shared/llm-config-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { LLMConfigService } from "../services/llm-config-service";
import { getLogger } from "../services/logger";
import { aiFailureCircuitBreaker } from "../services/ai-failure-circuit-breaker";

const logger = getLogger("llm-config-handlers");

export function registerLLMConfigHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();
  const configService = LLMConfigService.getInstance();

  // Check if valid LLM configuration exists
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_CHECK,
    async (_event: Electron.IpcMainInvokeEvent): Promise<LLMConfigCheckResult> => {
      logger.debug("Handling LLM_CONFIG_CHECK");
      return configService.checkConfiguration();
    }
  );

  // Validate LLM configuration by testing API calls
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_VALIDATE,
    async (
      _event: Electron.IpcMainInvokeEvent,
      config: LLMConfig
    ): Promise<LLMValidationResult> => {
      logger.debug({ mode: config.mode }, "Handling LLM_CONFIG_VALIDATE");
      return configService.validateConfiguration(config);
    }
  );

  // Save LLM configuration to database
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_SAVE,
    async (_event: Electron.IpcMainInvokeEvent, config: LLMConfig): Promise<void> => {
      logger.debug({ mode: config.mode }, "Handling LLM_CONFIG_SAVE");
      await configService.saveConfiguration(config);
      await aiFailureCircuitBreaker.handleConfigSaved(config);
      return void 0;
    }
  );

  // Get LLM configuration from database
  registry.registerHandler(
    IPC_CHANNELS.LLM_CONFIG_GET,
    async (_event: Electron.IpcMainInvokeEvent): Promise<LLMConfig | null> => {
      logger.debug("Handling LLM_CONFIG_GET");
      return configService.loadConfiguration();
    }
  );

  logger.info("LLM Config IPC handlers registered");
}
