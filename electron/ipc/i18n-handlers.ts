import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, IPCResult, toIPCError, LanguageChangePayload } from "@shared/ipc-types";
import { SupportedLanguage, isSupportedLanguage } from "@shared/i18n-types";
import { IPCHandlerRegistry } from "./handler-registry";

async function getMainI18n() {
  const { mainI18n } = await import("../services/i18n-service");
  return mainI18n;
}

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

    const mainI18n = await getMainI18n();
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

async function handleGetLanguage(): Promise<IPCResult<SupportedLanguage>> {
  try {
    const mainI18n = await getMainI18n();
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

async function handleGetSystemLanguage(): Promise<IPCResult<SupportedLanguage>> {
  try {
    const mainI18n = await getMainI18n();
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

export function registerI18nHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(IPC_CHANNELS.I18N_CHANGE_LANGUAGE, handleChangeLanguage);

  registry.registerHandler(IPC_CHANNELS.I18N_GET_LANGUAGE, handleGetLanguage);

  registry.registerHandler(IPC_CHANNELS.I18N_GET_SYSTEM_LANGUAGE, handleGetSystemLanguage);
}
