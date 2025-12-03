import { ipcMain, IpcMainInvokeEvent } from "electron";
import { IPCChannel } from "@shared/ipc-types";

/**
 * Type for IPC handler functions
 */
type IPCHandler<TRequest, TResponse> = (
  event: IpcMainInvokeEvent,
  request: TRequest
) => Promise<TResponse>;

/**
 * Type-safe IPC Handler Registry
 * Implements singleton pattern for centralized handler management
 */
export class IPCHandlerRegistry {
  private static instance: IPCHandlerRegistry | null = null;
  private registeredChannels: Set<string> = new Set();

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): IPCHandlerRegistry {
    if (!IPCHandlerRegistry.instance) {
      IPCHandlerRegistry.instance = new IPCHandlerRegistry();
    }
    return IPCHandlerRegistry.instance;
  }

  /**
   * Reset instance (for testing only)
   */
  static resetInstance(): void {
    IPCHandlerRegistry.instance = null;
  }

  /**
   * Register a handler for an IPC channel with type safety
   * @param channel - The IPC channel name
   * @param handler - The handler function
   */
  registerHandler<TRequest, TResponse>(
    channel: IPCChannel,
    handler: IPCHandler<TRequest, TResponse>
  ): void {
    if (this.registeredChannels.has(channel)) {
      console.warn(`[IPC] Handler for ${channel} already registered, skipping`);
      return;
    }

    ipcMain.handle(channel, handler);
    this.registeredChannels.add(channel);
  }

  /**
   * Check if a channel has a registered handler
   * @param channel - The IPC channel name
   */
  isRegistered(channel: IPCChannel): boolean {
    return this.registeredChannels.has(channel);
  }

  /**
   * Unregister a handler for an IPC channel
   * @param channel - The IPC channel name
   */
  unregisterHandler(channel: IPCChannel): void {
    if (this.registeredChannels.has(channel)) {
      ipcMain.removeHandler(channel);
      this.registeredChannels.delete(channel);
    }
  }

  /**
   * Unregister all handlers (for hot reload support)
   */
  unregisterAll(): void {
    for (const channel of this.registeredChannels) {
      ipcMain.removeHandler(channel);
    }
    this.registeredChannels.clear();
  }
}
