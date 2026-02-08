/**
 * FTS Health Service
 *
 * Manages FTS5 virtual table health checks and recovery.
 * Only handles screenshots_fts table, not the entire database.
 */

import type Database from "better-sqlite3";
import { getLogger } from "./logger";
import type { FtsHealthDetails, FtsHealthStatus, FtsStartupResult } from "../../shared/ipc-types";

const logger = getLogger("fts-health-service");

/**
 * FTS Health Service
 *
 * Singleton service for managing FTS5 health
 */
class FtsHealthService {
  private static instance: FtsHealthService | null = null;
  private status: FtsHealthStatus = "unknown";
  private lastCheckAt: number | null = null;
  private lastRebuildAt: number | null = null;
  private rebuildAttempts = 0;
  private isUsable = false;

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): FtsHealthService {
    if (!FtsHealthService.instance) {
      FtsHealthService.instance = new FtsHealthService();
    }
    return FtsHealthService.instance;
  }

  /**
   * Get current FTS health status
   */
  getStatus(): FtsHealthStatus {
    return this.status;
  }

  /**
   * Get detailed health information
   */
  getDetails(): FtsHealthDetails {
    return {
      status: this.status,
      lastCheckAt: this.lastCheckAt,
      lastRebuildAt: this.lastRebuildAt,
      rebuildAttempts: this.rebuildAttempts,
      isUsable: this.isUsable,
    };
  }

  /**
   * Check if FTS is currently usable
   */
  isFtsUsable(): boolean {
    return this.isUsable;
  }

  /**
   * Check if FTS table is empty (new user scenario)
   * Empty tables don't need integrity check
   */
  private isEmptyTable(sqlite: Database.Database): boolean {
    try {
      const result = sqlite.prepare("SELECT COUNT(*) as count FROM screenshots_fts").get() as
        | { count: number }
        | undefined;
      return result?.count === 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only "table doesn't exist" is genuinely empty (new user / fresh migration)
      if (/no such table/i.test(message)) {
        return true;
      }
      // Any other error (corruption, IO, permission) must enter repair path
      logger.warn({ error: message }, "FTS table query failed, not treating as empty");
      return false;
    }
  }

  /**
   * Run startup check and heal process
   *
   * Flow:
   * 1. Check if table is empty (new user) -> skip to healthy
   * 2. Run integrity-check
   * 3. If passed -> healthy
   * 4. If failed -> rebuild -> re-check
   * 5. If still failed -> degraded
   */
  async runStartupCheckAndHeal(
    sqlite: Database.Database,
    onRebuildStart?: () => void
  ): Promise<FtsStartupResult> {
    const startTime = Date.now();
    logger.info("Starting FTS5 health check");

    this.status = "unknown";
    let checkAttempts = 0;
    let rebuildPerformed = false;

    try {
      // Optimization: Empty table is always healthy (new user scenario)
      if (this.isEmptyTable(sqlite)) {
        this.status = "healthy";
        this.isUsable = true;
        this.lastCheckAt = Date.now();
        logger.info("FTS5 table is empty, skipping integrity check (new user)");
        return {
          status: "healthy",
          durationMs: Date.now() - startTime,
          checkAttempts: 0,
          rebuildPerformed: false,
        };
      }

      // First integrity check
      checkAttempts++;
      const firstCheck = this.runIntegrityCheck(sqlite);

      if (firstCheck.ok) {
        this.status = "healthy";
        this.isUsable = true;
        this.lastCheckAt = Date.now();

        const durationMs = Date.now() - startTime;
        logger.info({ durationMs }, "FTS5 health check passed");

        return {
          status: "healthy",
          durationMs,
          checkAttempts,
          rebuildPerformed: false,
        };
      }

      // First check failed, try rebuild
      logger.warn({ error: firstCheck.error }, "FTS5 integrity check failed, attempting rebuild");

      this.status = "rebuilding";
      onRebuildStart?.();
      const rebuildResult = this.runRebuild(sqlite);
      rebuildPerformed = true;

      if (!rebuildResult.ok) {
        // Rebuild failed immediately
        this.status = "degraded";
        this.isUsable = false;
        const durationMs = Date.now() - startTime;

        logger.error({ error: rebuildResult.error }, "FTS5 rebuild failed immediately");

        return {
          status: "degraded",
          durationMs,
          checkAttempts,
          rebuildPerformed: true,
          error: rebuildResult.error,
          errorCode: "FTS_REBUILD_FAILED",
        };
      }

      this.lastRebuildAt = Date.now();
      this.rebuildAttempts++;

      // Re-check after rebuild
      checkAttempts++;
      const secondCheck = this.runIntegrityCheck(sqlite);

      if (secondCheck.ok) {
        this.status = "healthy";
        this.isUsable = true;
        this.lastCheckAt = Date.now();

        const durationMs = Date.now() - startTime;
        logger.info({ durationMs, checkAttempts }, "FTS5 rebuild successful");

        return {
          status: "healthy",
          durationMs,
          checkAttempts,
          rebuildPerformed: true,
        };
      }

      // Rebuild succeeded but integrity check still failed
      this.status = "degraded";
      this.isUsable = false;
      const durationMs = Date.now() - startTime;

      logger.error({ error: secondCheck.error }, "FTS5 integrity check failed after rebuild");

      return {
        status: "degraded",
        durationMs,
        checkAttempts,
        rebuildPerformed: true,
        error: secondCheck.error,
        errorCode: "FTS_CHECK_FAILED_AFTER_REBUILD",
      };
    } catch (error) {
      // Unexpected error during check/heal
      this.status = "degraded";
      this.isUsable = false;
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error({ error }, "Unexpected error during FTS5 health check");

      return {
        status: "degraded",
        durationMs,
        checkAttempts,
        rebuildPerformed,
        error: errorMessage,
        errorCode: "FTS_CHECK_UNEXPECTED_ERROR",
      };
    }
  }

  /**
   * Manual retry FTS repair
   *
   * Can be called from UI when user clicks "retry repair"
   */
  async retryRepair(
    sqlite: Database.Database,
    onRebuildStart?: () => void
  ): Promise<FtsStartupResult> {
    logger.info("Manual FTS5 repair requested");

    // Reset rebuild attempts to allow another try
    this.rebuildAttempts = 0;

    return this.runStartupCheckAndHeal(sqlite, onRebuildStart);
  }

  /**
   * Run FTS5 integrity check
   *
   * Uses: INSERT INTO screenshots_fts(screenshots_fts) VALUES('integrity-check')
   */
  private runIntegrityCheck(
    sqlite: Database.Database
  ): { ok: true } | { ok: false; error: string } {
    try {
      // FTS5 integrity check command
      sqlite
        .prepare("INSERT INTO screenshots_fts(screenshots_fts) VALUES('integrity-check')")
        .run();
      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: errorMessage };
    }
  }

  /**
   * Rebuild FTS5 table
   *
   * Uses: INSERT INTO screenshots_fts(screenshots_fts) VALUES('rebuild')
   */
  private runRebuild(sqlite: Database.Database): { ok: true } | { ok: false; error: string } {
    try {
      // FTS5 rebuild command
      sqlite.prepare("INSERT INTO screenshots_fts(screenshots_fts) VALUES('rebuild')").run();
      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: errorMessage };
    }
  }

  /**
   * Recreate FTS5 table from scratch
   *
   * This is a more aggressive recovery that drops and recreates the FTS table,
   * then repopulates it from existing screenshots data.
   * Use as last resort when rebuild fails.
   */
  async recreateFtsTable(sqlite: Database.Database): Promise<boolean> {
    logger.warn("Attempting to recreate FTS5 table from scratch");

    try {
      // Drop existing FTS table
      sqlite.prepare("DROP TABLE IF EXISTS screenshots_fts").run();

      // Recreate FTS table
      sqlite
        .prepare(
          `
        CREATE VIRTUAL TABLE screenshots_fts USING fts5(
          ocr_text,
          content='screenshots',
          content_rowid='id'
        )
      `
        )
        .run();

      // Recreate triggers
      sqlite
        .prepare(
          `
        CREATE TRIGGER IF NOT EXISTS screenshots_fts_insert AFTER INSERT ON screenshots
        WHEN NEW.ocr_text IS NOT NULL
        BEGIN
          INSERT INTO screenshots_fts(rowid, ocr_text) VALUES (NEW.id, NEW.ocr_text);
        END
      `
        )
        .run();

      sqlite
        .prepare(
          `
        CREATE TRIGGER IF NOT EXISTS screenshots_fts_update AFTER UPDATE OF ocr_text ON screenshots
        BEGIN
          DELETE FROM screenshots_fts WHERE rowid = OLD.id;
          INSERT INTO screenshots_fts(rowid, ocr_text) 
          SELECT NEW.id, NEW.ocr_text WHERE NEW.ocr_text IS NOT NULL;
        END
      `
        )
        .run();

      sqlite
        .prepare(
          `
        CREATE TRIGGER IF NOT EXISTS screenshots_fts_delete AFTER DELETE ON screenshots
        BEGIN
          DELETE FROM screenshots_fts WHERE rowid = OLD.id;
        END
      `
        )
        .run();

      // Repopulate from existing data
      sqlite
        .prepare(
          `
        INSERT INTO screenshots_fts(rowid, ocr_text)
        SELECT id, ocr_text FROM screenshots WHERE ocr_text IS NOT NULL
      `
        )
        .run();

      this.lastRebuildAt = Date.now();
      this.rebuildAttempts++;

      logger.info("FTS5 table recreated successfully");
      return true;
    } catch (error) {
      logger.error({ error }, "Failed to recreate FTS5 table");
      return false;
    }
  }

  /**
   * Reset service state (for testing)
   */
  reset(): void {
    this.status = "unknown";
    this.lastCheckAt = null;
    this.lastRebuildAt = null;
    this.rebuildAttempts = 0;
    this.isUsable = false;
  }
}

export const ftsHealthService = FtsHealthService.getInstance();
