import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { getLogger } from "../services/logger";
import * as schema from "./schema";

export type DrizzleDB = BetterSQLite3Database<typeof schema>;

/**
 * Database service singleton class
 * Manages SQLite connection and Drizzle ORM instance
 */
class DatabaseService {
  private static instance: DatabaseService | null = null;
  private readonly logger = getLogger("database");
  private db: DrizzleDB | null = null;
  private sqlite: Database.Database | null = null;

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  /**
   * Get the singleton instance of DatabaseService
   */
  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  /**
   * Get the database file path in user data directory
   */
  getPath(): string {
    const userDataPath = app.getPath("userData");
    return path.join(userDataPath, "mnemora.db");
  }

  /**
   * Get the raw SQLite instance
   * Used by FTS health service for direct SQLite operations
   */
  getSqlite(): Database.Database | null {
    return this.sqlite;
  }

  /**
   * Initialize the database connection
   * Creates the database file if it doesn't exist and runs migrations
   *
   * Note: FTS5 health checks are handled separately in the boot process
   * to allow for non-blocking recovery and graceful degradation.
   */
  initialize(): DrizzleDB {
    if (this.db) {
      return this.db;
    }

    const dbPath = this.getPath();
    this.logger.info({ dbPath }, "Initializing database");

    // Ensure the directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open database connection
    this.sqlite = new Database(dbPath);

    // Enable WAL mode for better performance
    this.sqlite.pragma("journal_mode = WAL");

    // Enable foreign keys
    this.sqlite.pragma("foreign_keys = ON");

    // Create Drizzle instance with schema
    this.db = drizzle(this.sqlite, { schema });

    // Run migrations
    this.runMigrations();

    this.logger.info("Database initialized successfully");
    return this.db;
  }

  /**
   * Run database migrations programmatically
   * Uses drizzle-orm's migrate() to apply SQL files from the migrations folder
   *
   * Workflow:
   * 1. Developer runs `pnpm db:generate` to create migration SQL files
   * 2. At runtime, this function applies those migrations to the user's database
   */
  private runMigrations(): void {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    this.logger.info("Running database migrations...");

    // Resolve migrations folder with optimized path resolution
    // Prioritize unpacked path for packaged apps to avoid asar extraction overhead
    const migrationsFolder = this.resolveMigrationsFolder();

    if (!migrationsFolder) {
      this.logger.warn("Migrations folder not found, skipping migrations");
      return;
    }

    this.logger.info({ migrationsFolder }, "Migrations folder resolved");

    // Run migrations using drizzle-orm's migrate function
    migrate(this.db, { migrationsFolder });

    this.logger.info("Migrations completed");
  }

  /**
   * Resolve migrations folder with minimal file system checks
   * Optimized for Windows performance: avoids multiple existsSync calls
   */
  private resolveMigrationsFolder(): string | null {
    // Allow explicit override for tests or custom setups
    if (process.env.MIGRATIONS_DIR && fs.existsSync(process.env.MIGRATIONS_DIR)) {
      return process.env.MIGRATIONS_DIR;
    }

    // Development mode: use source path directly
    if (!app.isPackaged) {
      const devPath = path.join(
        process.env.APP_ROOT ?? app.getAppPath(),
        "electron",
        "database",
        "migrations"
      );
      if (fs.existsSync(devPath)) {
        return devPath;
      }
      return null;
    }

    // Packaged app: prioritize unpacked path (fastest, no asar extraction)
    const unpackedPath = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "dist-electron",
      "migrations"
    );
    if (fs.existsSync(unpackedPath)) {
      return unpackedPath;
    }

    // Fallback to other common paths (single check each)
    const fallbackPaths = [
      path.join(process.resourcesPath, "dist-electron", "migrations"),
      path.join(app.getAppPath(), "dist-electron", "migrations"),
    ];

    for (const p of fallbackPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Get the Drizzle database instance
   * Auto-initializes if not already initialized (lazy loading)
   */
  getDatabase(): DrizzleDB {
    if (!this.db) {
      this.initialize();
    }
    return this.db!;
  }

  /**
   * Close the database connection
   * Should be called when the app is quitting
   */
  close(): void {
    if (this.sqlite) {
      this.logger.info("Closing database connection");
      this.sqlite.close();
      this.sqlite = null;
      this.db = null;
    }
  }

  /**
   * Check if database is initialized
   */
  isInitialized(): boolean {
    return this.db !== null;
  }
}

export const databaseService = DatabaseService.getInstance();

// Helper function to get database instance (lazy initialization)
export const getDb = (): DrizzleDB => databaseService.getDatabase();

export * from "./schema";
