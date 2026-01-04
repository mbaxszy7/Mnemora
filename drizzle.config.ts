import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit Configuration
 *
 * IMPORTANT: This configuration is for development-time migration generation only.
 * It uses a local dev.db file in the project root for drizzle-kit commands.
 *
 * The actual production database is created in app.getPath('userData') at runtime
 * and migrations are applied programmatically using drizzle-orm's migrate().
 *
 * This separation solves the NODE_MODULE_VERSION mismatch issue between
 * drizzle-kit (runs in Node.js) and better-sqlite3 (compiled for Electron).
 */
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
    url:
      process.platform === "win32"
        ? "C:/Users/aqcze/AppData/Roaming/Mnemora/mnemora.db"
        : "/Users/yanzheyu/Library/Application Support/Mnemora/mnemora.db",
  },

  // Verbose logging during development
  verbose: true,

  // Strict mode for safer migrations
  strict: true,
});
