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
   * Initialize the database connection
   * Creates the database file if it doesn't exist and runs migrations
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

    // Create SQLite connection
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

    // Resolve migrations folder (supports dev, packaged, and unpacked-asar layouts)
    const candidates: string[] = [];

    // Allow explicit override for tests or custom setups
    if (process.env.MIGRATIONS_DIR) {
      candidates.push(process.env.MIGRATIONS_DIR);
    }

    candidates.push(
      path.join(process.env.APP_ROOT ?? app.getAppPath(), "electron", "database", "migrations")
    );

    // Packaged app: prefer unpacked resources path
    candidates.push(
      path.join(process.resourcesPath, "app.asar.unpacked", "dist-electron", "migrations"),
      path.join(process.resourcesPath, "dist-electron", "migrations"),
      path.join(app.getAppPath(), "dist-electron", "migrations"),
      // Inside asar archive (Vite copies migrations to dist-electron/migrations)
      path.join(process.resourcesPath, "app.asar", "dist-electron", "migrations")
    );

    const migrationsFolder = candidates.find((p) => fs.existsSync(p));

    this.logger.info({ migrationsFolder, candidates }, "Migrations folder resolution");

    if (!migrationsFolder) {
      this.logger.warn({ candidates }, "Migrations folder not found, skipping migrations");
      return;
    }

    // Run migrations using drizzle-orm's migrate function
    migrate(this.db, { migrationsFolder });

    this.logger.info("Migrations completed");
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
