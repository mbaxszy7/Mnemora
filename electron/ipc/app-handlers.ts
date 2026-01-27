import { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, IPCResult, toIPCError, AppUpdateTitleBarPayload } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";

// App-level IPC handlers for window control, title bar, etc.
async function handleUpdateTitleBar(
  _event: IpcMainInvokeEvent,
  payload: AppUpdateTitleBarPayload
): Promise<IPCResult<void>> {
  try {
    if (process.platform !== "win32") {
      return { success: true };
    }

    const wins = BrowserWindow.getAllWindows();
    const mainWin = wins.find((w) => !w.isDestroyed());

    if (mainWin) {
      mainWin.setTitleBarOverlay({
        color: payload.backgroundColor,
        symbolColor: payload.symbolColor,
      });
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: toIPCError(error),
    };
  }
}

export function registerAppHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(IPC_CHANNELS.APP_UPDATE_TITLE_BAR, handleUpdateTitleBar);
}
