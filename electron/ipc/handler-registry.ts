import { ipcMain, IpcMainInvokeEvent } from "electron";
import { IPCChannel } from "@shared/ipc-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IPCHandler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>;

export class IPCHandlerRegistry {
  private static instance: IPCHandlerRegistry | null = null;
  private registeredChannels: Set<string> = new Set();

  private constructor() {}

  static getInstance(): IPCHandlerRegistry {
    if (!IPCHandlerRegistry.instance) {
      IPCHandlerRegistry.instance = new IPCHandlerRegistry();
    }
    return IPCHandlerRegistry.instance;
  }

  static resetInstance(): void {
    IPCHandlerRegistry.instance = null;
  }

  registerHandler(channel: IPCChannel, handler: IPCHandler): void {
    if (this.registeredChannels.has(channel)) {
      console.warn(`[IPC] Handler for ${channel} already registered, skipping`);
      return;
    }

    ipcMain.handle(channel, handler);
    this.registeredChannels.add(channel);
  }

  isRegistered(channel: IPCChannel): boolean {
    return this.registeredChannels.has(channel);
  }

  unregisterHandler(channel: IPCChannel): void {
    if (this.registeredChannels.has(channel)) {
      ipcMain.removeHandler(channel);
      this.registeredChannels.delete(channel);
    }
  }

  unregisterAll(): void {
    for (const channel of this.registeredChannels) {
      ipcMain.removeHandler(channel);
    }
    this.registeredChannels.clear();
  }
}
