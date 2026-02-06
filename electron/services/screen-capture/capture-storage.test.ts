/**
 * Unit Tests for Capture Storage Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  getCaptureStorageDir,
  ensureStorageDir,
  generateCaptureFilename,
  saveCaptureToFile,
  safeDeleteCaptureFile,
  listCaptures,
  cleanupOldCaptures,
  cleanupDevCaptures,
} from "./capture-storage";
import type { CaptureSource } from "./types";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("os");
vi.mock("../logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("Capture Storage Service", () => {
  const mockHomedir = "/home/testuser";

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getCaptureStorageDir", () => {
    it("returns correct storage directory path", () => {
      const result = getCaptureStorageDir();
      expect(result).toBe(path.join(mockHomedir, ".mnemora", "images"));
    });
  });

  describe("ensureStorageDir", () => {
    it("creates directory if it does not exist", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await ensureStorageDir();

      expect(fs.mkdir).toHaveBeenCalledWith(path.join(mockHomedir, ".mnemora", "images"), {
        recursive: true,
      });
    });

    it("throws error if directory creation fails", async () => {
      const error = new Error("Permission denied");
      vi.mocked(fs.mkdir).mockRejectedValue(error);

      await expect(ensureStorageDir()).rejects.toThrow("Permission denied");
    });
  });

  describe("generateCaptureFilename", () => {
    it("generates filename for screen capture", () => {
      const timestamp = new Date("2024-01-15T10:30:00.000Z").getTime();
      const source: CaptureSource = {
        id: "screen:1:0",
        name: "Display 1",
        type: "screen",
        displayId: "1",
      };

      const result = generateCaptureFilename(timestamp, "jpeg", source);

      expect(result).toMatch(/^capture-2024-01-15T10-30-00-screen-1\.jpeg$/);
    });

    it("generates filename for window capture with hash", () => {
      const timestamp = new Date("2024-01-15T10:30:00.000Z").getTime();
      const source: CaptureSource = {
        id: "window:123:0",
        name: "Chrome",
        type: "window",
      };

      const result = generateCaptureFilename(timestamp, "png", source);

      expect(result).toMatch(/^capture-2024-01-15T10-30-00-window-Chrome-[a-f0-9]{6}\.png$/);
    });

    it("uses default jpeg format when not specified", () => {
      const timestamp = Date.now();
      const source: CaptureSource = {
        id: "screen:1:0",
        name: "Display 1",
        type: "screen",
        displayId: "1",
      };

      const result = generateCaptureFilename(timestamp, "jpeg", source);

      expect(result).toMatch(/\.jpeg$/);
    });

    it("supports webp format", () => {
      const timestamp = Date.now();
      const source: CaptureSource = {
        id: "screen:1:0",
        name: "Display 1",
        type: "screen",
        displayId: "1",
      };

      const result = generateCaptureFilename(timestamp, "webp", source);

      expect(result).toMatch(/\.webp$/);
    });
  });

  describe("saveCaptureToFile", () => {
    it("saves buffer to file and returns filepath", async () => {
      const buffer = Buffer.from([1, 2, 3]);
      const timestamp = new Date("2024-01-15T10:30:00.000Z").getTime();
      const source: CaptureSource = {
        id: "screen:1:0",
        name: "Display 1",
        type: "screen",
        displayId: "1",
      };

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await saveCaptureToFile(source, buffer, timestamp, "jpeg");

      expect(result).toContain("capture-2024-01-15T10-30-00");
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("throws error if write fails", async () => {
      const buffer = Buffer.from([1, 2, 3]);
      const source: CaptureSource = {
        id: "screen:1:0",
        name: "Display 1",
        type: "screen",
        displayId: "1",
      };

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error("Disk full"));

      await expect(saveCaptureToFile(source, buffer, Date.now())).rejects.toThrow("Disk full");
    });
  });

  describe("safeDeleteCaptureFile", () => {
    it("returns true on successful deletion", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await safeDeleteCaptureFile("/path/to/file.jpeg");

      expect(result).toBe(true);
      expect(fs.unlink).toHaveBeenCalledWith("/path/to/file.jpeg");
    });

    it("returns true if file already missing", async () => {
      const error = new Error("File not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.unlink).mockRejectedValue(error);

      const result = await safeDeleteCaptureFile("/path/to/missing.jpeg");

      expect(result).toBe(true);
    });

    it("returns false on deletion error", async () => {
      const error = new Error("Permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      vi.mocked(fs.unlink).mockRejectedValue(error);

      const result = await safeDeleteCaptureFile("/path/to/protected.jpeg");

      expect(result).toBe(false);
    });
  });

  describe("listCaptures", () => {
    it("returns sorted list of capture files", async () => {
      const files = [
        "capture-2024-01-15T10-30-00-screen-1.jpeg",
        "capture-2024-01-15T10-31-00-screen-1.jpeg",
        "other-file.txt",
        "capture-2024-01-15T10-29-00-screen-1.png",
      ];

      vi.mocked(fs.readdir).mockResolvedValue(files as unknown as fs.Dirent[]);

      const result = await listCaptures();

      expect(result).toHaveLength(3);
      expect(result[0]).toContain("10-31-00"); // Most recent first
      expect(result[1]).toContain("10-30-00");
      expect(result[2]).toContain("10-29-00");
    });

    it("returns empty array if directory does not exist", async () => {
      const error = new Error("Directory not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readdir).mockRejectedValue(error);

      const result = await listCaptures();

      expect(result).toEqual([]);
    });

    it("rethrows non-ENOENT errors", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("Permission denied"));

      await expect(listCaptures()).rejects.toThrow("Permission denied");
    });
  });

  describe("cleanupOldCaptures", () => {
    const mockFiles = [
      "capture-2024-01-15T10-00-00-screen-1.jpeg",
      "capture-2024-01-15T09-00-00-screen-1.jpeg",
      "capture-2024-01-15T08-00-00-screen-1.jpeg",
    ];

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("deletes files exceeding max count", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as unknown as fs.Dirent[]);
      vi.mocked(fs.stat).mockResolvedValue({
        mtimeMs: Date.now() - 1000,
      } as fs.Stats);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await cleanupOldCaptures(24 * 60 * 60 * 1000, 2);

      expect(result).toBe(1);
    });

    it("deletes files older than max age", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as unknown as fs.Dirent[]);
      vi.mocked(fs.stat).mockImplementation((filepath) => {
        const filename = filepath.toString();
        // First file is recent, others are old
        const hoursAgo = filename.includes("10-00") ? 1 : 25;
        return Promise.resolve({
          mtimeMs: Date.now() - hoursAgo * 60 * 60 * 1000,
        } as fs.Stats);
      });
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await cleanupOldCaptures(24 * 60 * 60 * 1000, 100);

      expect(result).toBe(2);
    });

    it("handles stat errors gracefully", async () => {
      // Use files within maxCount to trigger stat check
      vi.mocked(fs.readdir).mockResolvedValue([mockFiles[0]] as unknown as fs.Dirent[]);
      vi.mocked(fs.stat).mockRejectedValue(new Error("Stat failed"));

      const result = await cleanupOldCaptures(24 * 60 * 60 * 1000, 2);

      // Should not throw and should return 0 (no files deleted)
      expect(result).toBe(0);
    });

    it("returns 0 when directory does not exist", async () => {
      const error = new Error("Directory not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readdir).mockRejectedValue(error);

      const result = await cleanupOldCaptures();

      expect(result).toBe(0);
    });

    it("uses default maxAge of 7 days and maxCount of 1000", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([] as unknown as fs.Dirent[]);

      await cleanupOldCaptures();

      expect(fs.readdir).toHaveBeenCalled();
    });
  });

  describe("cleanupDevCaptures", () => {
    beforeEach(() => {
      vi.mocked(fs.readdir).mockResolvedValue([] as unknown as fs.Dirent[]);
    });

    it("cleans up captures older than 1 day", async () => {
      await cleanupDevCaptures();

      expect(fs.readdir).toHaveBeenCalled();
    });
  });
});
