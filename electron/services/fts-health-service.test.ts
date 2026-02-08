import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

import { ftsHealthService } from "./fts-health-service";

describe("FtsHealthService", () => {
  let mockSqlite: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    ftsHealthService.reset();

    // Create mock SQLite database
    mockSqlite = {
      prepare: vi.fn(),
    } as unknown as Database.Database;
  });

  describe("empty table optimization (new user)", () => {
    it("skips integrity check for empty table", async () => {
      // Mock empty table count query
      const mockGet = vi.fn().mockReturnValue({ count: 0 });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        get: mockGet,
        run: vi.fn(),
      });

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("healthy");
      expect(result.checkAttempts).toBe(0);
      expect(result.rebuildPerformed).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "FTS5 table is empty, skipping integrity check (new user)"
      );
    });

    it("treats missing table as empty", async () => {
      // Mock query failure (table doesn't exist)
      const mockGet = vi.fn().mockImplementation(() => {
        throw new Error("no such table");
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        get: mockGet,
      });

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("healthy");
      expect(result.checkAttempts).toBe(0);
    });

    it("does not treat corrupt table as empty", async () => {
      // Mock COUNT query throwing SQLITE_CORRUPT
      let callCount = 0;
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return {
            get: vi.fn().mockImplementation(() => {
              throw new Error("SQLITE_CORRUPT_VTAB: database disk image is malformed");
            }),
          };
        }
        // integrity-check and rebuild commands
        return {
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              throw new Error("SQLITE_CORRUPT_VTAB"); // first check fails
            }
            return {}; // rebuild + recheck succeed
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      // Should NOT skip to healthy — should attempt repair
      expect(result.checkAttempts).toBeGreaterThan(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("SQLITE_CORRUPT") }),
        "FTS table query failed, not treating as empty"
      );
    });

    it("does not treat IO/permission errors as empty", async () => {
      // Mock COUNT query throwing a generic IO error
      let callCount = 0;
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return {
            get: vi.fn().mockImplementation(() => {
              throw new Error("disk I/O error");
            }),
          };
        }
        return {
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              throw new Error("disk I/O error"); // first check fails
            }
            return {}; // rebuild + recheck succeed
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      // Should NOT skip to healthy — should enter repair path
      expect(result.checkAttempts).toBeGreaterThan(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("disk I/O error") }),
        "FTS table query failed, not treating as empty"
      );
    });

    it("runs full check when table has data", async () => {
      // Mock non-empty table
      const mockGet = vi.fn().mockReturnValue({ count: 100 });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        get: mockGet,
        run: vi.fn().mockReturnValue({}),
      });

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      // Should run integrity check
      expect(result.checkAttempts).toBe(1);
      expect(result.status).toBe("healthy");
    });
  });

  describe("runStartupCheckAndHeal", () => {
    it("returns healthy when integrity check passes", async () => {
      // Mock non-empty table (count query returns 1, then integrity check succeeds)
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) };
        }
        if (sql.includes("COALESCE(ocr_text")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        return { run: vi.fn().mockReturnValue({}) };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("healthy");
      expect(result.checkAttempts).toBe(1);
      expect(result.rebuildPerformed).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ durationMs: expect.any(Number) }),
        "FTS5 health check passed"
      );
    });

    it("rebuilds and returns healthy when rebuild succeeds", async () => {
      let callCount = 0;
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) }; // non-empty table
        }
        if (sql.includes("COALESCE(ocr_text")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        // For integrity-check and rebuild commands
        const mockRun = vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error("FTS5 integrity check failed"); // first check fails
          }
          return {}; // rebuild succeeds, recheck succeeds
        });
        return { run: mockRun };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("healthy");
      expect(result.checkAttempts).toBe(2);
      expect(result.rebuildPerformed).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
        "FTS5 startup validation failed, attempting rebuild"
      );
    });

    it("returns degraded when rebuild fails immediately", async () => {
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) }; // non-empty table
        }
        return {
          run: vi.fn().mockImplementation(() => {
            throw new Error("FTS5 rebuild failed");
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("degraded");
      expect(result.rebuildPerformed).toBe(true);
      expect(result.errorCode).toBe("FTS_REBUILD_FAILED");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
        "FTS5 rebuild failed immediately"
      );
    });

    it("returns degraded when recheck after rebuild fails", async () => {
      let callCount = 0;
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) }; // non-empty table
        }
        return {
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1 || callCount === 3) {
              throw new Error("FTS5 integrity check failed");
            }
            return {}; // rebuild succeeds (callCount === 2)
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("degraded");
      expect(result.checkAttempts).toBe(2);
      expect(result.rebuildPerformed).toBe(true);
      expect(result.errorCode).toBe("FTS_CHECK_FAILED_AFTER_REBUILD");
    });

    it("returns degraded on unexpected error during integrity check", async () => {
      // Non-empty table with failing integrity check
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) };
        }
        return {
          run: vi.fn().mockImplementation(() => {
            throw new Error("Unexpected SQLite error");
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("degraded");
      expect(result.errorCode).toBe("FTS_REBUILD_FAILED");
    });
  });

  describe("retryRepair", () => {
    it("resets rebuild attempts and runs check again", async () => {
      // First call makes it degraded (non-empty table with failing check)
      const mockPrepareDegraded = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) };
        }
        return {
          run: vi.fn().mockImplementation(() => {
            throw new Error("FTS5 integrity check failed");
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepareDegraded;

      await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      // Retry should work with fresh state (empty table, skip check)
      const mockPrepareSuccess = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 0 }) }; // empty table
        }
        return { run: vi.fn().mockReturnValue({}) };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepareSuccess;

      const result = await ftsHealthService.retryRepair(mockSqlite);

      expect(result.status).toBe("healthy");
    });
  });

  describe("getStatus and getDetails", () => {
    it("returns unknown status before check", () => {
      expect(ftsHealthService.getStatus()).toBe("unknown");
      expect(ftsHealthService.getDetails().isUsable).toBe(false);
    });

    it("returns healthy status after successful check", async () => {
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) }; // non-empty table
        }
        if (sql.includes("COALESCE(ocr_text")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        return { run: vi.fn().mockReturnValue({}) };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(ftsHealthService.getStatus()).toBe("healthy");
      expect(ftsHealthService.getDetails().isUsable).toBe(true);
      expect(ftsHealthService.isFtsUsable()).toBe(true);
    });

    it("returns degraded status after failed check", async () => {
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) }; // non-empty table
        }
        return {
          run: vi.fn().mockImplementation(() => {
            throw new Error("FTS5 check failed");
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(ftsHealthService.getStatus()).toBe("degraded");
      expect(ftsHealthService.getDetails().isUsable).toBe(false);
      expect(ftsHealthService.isFtsUsable()).toBe(false);
    });
  });

  describe("recreateFtsTable", () => {
    it("successfully recreates FTS table", async () => {
      const mockRun = vi.fn().mockReturnValue({});
      (mockSqlite.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        run: mockRun,
      });

      const result = await ftsHealthService.recreateFtsTable(mockSqlite);

      expect(result).toBe(true);
      expect(mockSqlite.prepare).toHaveBeenCalledWith(
        expect.stringContaining("DROP TABLE IF EXISTS screenshots_fts")
      );
      expect(mockSqlite.prepare).toHaveBeenCalledWith(
        expect.stringContaining("CREATE VIRTUAL TABLE screenshots_fts")
      );
      expect(mockLogger.info).toHaveBeenCalledWith("FTS5 table recreated successfully");
    });

    it("returns false when recreation fails", async () => {
      const mockRun = vi.fn().mockImplementation(() => {
        throw new Error("Cannot create FTS table");
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        run: mockRun,
      });

      const result = await ftsHealthService.recreateFtsTable(mockSqlite);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Object) }),
        "Failed to recreate FTS5 table"
      );
    });
  });

  describe("trigger normalization failure", () => {
    it("logs warning when trigger normalization fails but continues check", async () => {
      // Mock hasFtsTable returning true (table exists)
      // But trigger creation fails
      let callCount = 0;
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master")) {
          return { get: vi.fn().mockReturnValue({ present: 1 }) };
        }
        if (sql.includes("DROP TRIGGER") || sql.includes("CREATE TRIGGER")) {
          throw new Error("Permission denied: cannot create trigger");
        }
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) };
        }
        if (sql.includes("COALESCE(ocr_text")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        // integrity-check and rebuild
        return {
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              throw new Error("FTS5 integrity check failed");
            }
            return {};
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      // Should log warning about trigger normalization failure
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Permission denied") }),
        "Failed to normalize FTS triggers before health check"
      );
      // Should still attempt the full check flow
      expect(result.checkAttempts).toBeGreaterThan(0);
    });
  });

  describe("unexpected error handling", () => {
    it("returns degraded when unexpected error occurs during check", async () => {
      // Mock prepare to throw an error that bypasses inner error handling
      // This happens when prepare itself throws (not run/get)
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) };
        }
        if (sql.includes("integrity-check") || sql.includes("rebuild")) {
          // Return an object with run that throws
          return {
            run: vi.fn().mockImplementation(() => {
              throw new Error("Unexpected system error");
            }),
          };
        }
        throw new Error("Unexpected prepare error");
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("degraded");
      // Inner error handling returns FTS_REBUILD_FAILED for integrity check errors
      expect(result.errorCode).toBe("FTS_REBUILD_FAILED");
      expect(result.error).toContain("Unexpected system error");
    });

    it("returns degraded with rebuildPerformed true when error occurs after rebuild", async () => {
      let callCount = 0;
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ count: 1 }) };
        }
        if (sql.includes("COALESCE(ocr_text")) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        return {
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              throw new Error("First check failed");
            }
            if (callCount === 2) {
              // Rebuild succeeds
              return {};
            }
            // Second check throws unexpected error
            throw new Error("Unexpected error during recheck");
          }),
        };
      });
      (mockSqlite.prepare as ReturnType<typeof vi.fn>) = mockPrepare;

      const result = await ftsHealthService.runStartupCheckAndHeal(mockSqlite);

      expect(result.status).toBe("degraded");
      expect(result.rebuildPerformed).toBe(true);
      // When rebuild succeeds but recheck fails, errorCode is FTS_CHECK_FAILED_AFTER_REBUILD
      expect(result.errorCode).toBe("FTS_CHECK_FAILED_AFTER_REBUILD");
    });
  });
});
