/* eslint-disable @typescript-eslint/no-unused-vars */
import { eq } from "drizzle-orm";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { db, settings } from "../database";
import { IPCHandlerRegistry } from "./handler-registry";
import { getLogger } from "../services/logger";

const logger = getLogger("database-handlers");

export function registerDatabaseHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  // Settings handlers
  registry.registerHandler(IPC_CHANNELS.DB_SETTINGS_GET, handleGetSetting);
  registry.registerHandler(IPC_CHANNELS.DB_SETTINGS_SET, handleSetSetting);
  registry.registerHandler(IPC_CHANNELS.DB_SETTINGS_GET_ALL, handleGetAllSettings);

  logger.info("Database IPC handlers registered");
}

// ============================================================================
// Settings Handlers
// ============================================================================

async function handleGetSetting(
  _event: Electron.IpcMainInvokeEvent,
  key: string
): Promise<string | null> {
  const result = db.select().from(settings).where(eq(settings.key, key)).get();
  return result?.value ?? null;
}

async function handleSetSetting(
  _event: Electron.IpcMainInvokeEvent,
  key: string,
  value: string
): Promise<void> {
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();

  if (existing) {
    db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value }).run();
  }
}

async function handleGetAllSettings(
  _event: Electron.IpcMainInvokeEvent
): Promise<Array<{ key: string; value: string | null }>> {
  return db.select({ key: settings.key, value: settings.value }).from(settings).all();
}
