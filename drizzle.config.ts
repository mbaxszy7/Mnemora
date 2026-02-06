import { defineConfig } from "drizzle-kit";
import path from "node:path";
import os from "node:os";

/**
 * Drizzle Kit Configuration
 *
 * IMPORTANT: This configuration is for development-time migration generation only.
 * It uses a local SQLite file for drizzle-kit commands (override via DEV_DB_PATH).
 *
 * The actual production database is created in app.getPath('userData') at runtime
 * and migrations are applied programmatically using drizzle-orm's migrate().
 *
 * This separation solves the NODE_MODULE_VERSION mismatch issue between
 * drizzle-kit (runs in Node.js) and better-sqlite3 (compiled for Electron).
 */

/**
 * Get the default database path for development
 * Uses environment variable DEV_DB_PATH if set, otherwise uses a per-user location.
 *
 * Note: SQLite can create the database file, but it will not create missing parent directories.
 * If you rely on the default path, ensure the parent directory exists first.
 */
function getDevDbPath(): string {
  // Allow override via environment variable
  if (process.env.DEV_DB_PATH) {
    return process.env.DEV_DB_PATH;
  }

  // Use home directory for cross-platform compatibility
  // Windows: %APPDATA%/Mnemora/mnemora.db
  // macOS/Linux: ~/.mnemora/mnemora.db
  const homeDir = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, "Mnemora", "mnemora.db");
  }
  return path.join(homeDir, ".mnemora", "mnemora.db");
}

export default defineConfig({
  // Schema location
  schema: "./electron/database/schema.ts",

  // Migration output directory
  out: "./electron/database/migrations",

  // Use SQLite dialect
  dialect: "sqlite",

  // Development database for drizzle-kit commands
  // This is NOT the production database
  dbCredentials: {
    url: getDevDbPath(),
  },

  // Verbose logging during development
  verbose: true,

  // Strict mode for safer migrations
  strict: true,
});
