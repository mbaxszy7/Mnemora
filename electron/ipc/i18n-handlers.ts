import type { IpcMainInvokeEvent } from "electron";
import { mainI18n } from "../services/i18n-service";
import { IPC_CHANNELS, IPCResult, toIPCError, LanguageChangePayload } from "@shared/ipc-types";
import { SupportedLanguage, isSupportedLanguage } from "@shared/i18n-types";
import { IPCHandlerRegistry } from "./handler-registry";

/**
 * Handle language change request
 * Receives language code and updates the main process i18n service
 */
async function handleChangeLanguage(
  _event: IpcMainInvokeEvent,
  payload: LanguageChangePayload
): Promise<IPCResult<void>> {
  try {
    const { language } = payload;

    // Validate language
    if (!isSupportedLanguage(language)) {
      return {
        success: false,
        error: toIPCError(new Error(`Unsupported language: ${language}`)),
      };
    }

    await mainI18n.changeLanguage(language);

    return {
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: toIPCError(error),
    };
  }
}

/**
 * Handle get current language request
 * Returns the current language setting from main process
 */
async function handleGetLanguage(): Promise<IPCResult<SupportedLanguage>> {
  try {
    const language = mainI18n.getCurrentLanguage();

    return {
      success: true,
      data: language,
    };
  } catch (error) {
    return {
      success: false,
      error: toIPCError(error),
    };
  }
}

/**
 * Handle get system language request
 * Returns the detected system language
 */
async function handleGetSystemLanguage(): Promise<IPCResult<SupportedLanguage>> {
  try {
    const language = mainI18n.detectSystemLanguage();

    return {
      success: true,
      data: language,
    };
  } catch (error) {
    return {
      success: false,
      error: toIPCError(error),
    };
  }
}

/**
 * Register all i18n IPC handlers using IPCHandlerRegistry
 * Should be called during app initialization
 */
export function registerI18nHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler<LanguageChangePayload, IPCResult<void>>(
    IPC_CHANNELS.I18N_CHANGE_LANGUAGE,
    handleChangeLanguage
  );

  registry.registerHandler<void, IPCResult<SupportedLanguage>>(
    IPC_CHANNELS.I18N_GET_LANGUAGE,
    handleGetLanguage
  );

  registry.registerHandler<void, IPCResult<SupportedLanguage>>(
    IPC_CHANNELS.I18N_GET_SYSTEM_LANGUAGE,
    handleGetSystemLanguage
  );
}
