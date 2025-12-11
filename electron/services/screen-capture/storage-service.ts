/**
 * Storage Service for Screen Captures
 *
 * Handles saving captured images to disk in the user's home directory.
 * Images are stored in ~/.mnemora/images/ with timestamp-based filenames.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getLogger } from "../logger";

const logger = getLogger("capture-storage");

/**
 * Get the base directory for storing captures
 */
export function getCaptureStorageDir(): string {
  return path.join(os.homedir(), ".mnemora", "images");
}

/**
 * Ensure the storage directory exists
 */
export async function ensureStorageDir(): Promise<void> {
  const dir = getCaptureStorageDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    logger.debug({ dir }, "Storage directory ensured");
  } catch (error) {
    logger.error({ error, dir }, "Failed to create storage directory");
    throw error;
  }
}

/**
 * Generate a filename for a capture based on timestamp
 */
export function generateCaptureFilename(
  timestamp: number,
  format: "jpeg" | "png" | "webp" = "jpeg"
): string {
  const date = new Date(timestamp);
  const dateStr = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `capture-${dateStr}.${format}`;
}

/**
 * Save a capture buffer to disk
 *
 * @param buffer - The image buffer to save
 * @param timestamp - The capture timestamp
 * @param format - The image format
 * @returns The full path to the saved file
 */
export async function saveCaptureToFile(
  buffer: Buffer,
  timestamp: number,
  format: "jpeg" | "png" | "webp" = "jpeg"
): Promise<string> {
  await ensureStorageDir();

  const filename = generateCaptureFilename(timestamp, format);
  const filepath = path.join(getCaptureStorageDir(), filename);

  try {
    await fs.writeFile(filepath, buffer);
    logger.info({ filepath, size: buffer.length }, "Capture saved to file");
    return filepath;
  } catch (error) {
    logger.error({ error, filepath }, "Failed to save capture to file");
    throw error;
  }
}

/**
 * List all captures in the storage directory
 */
export async function listCaptures(): Promise<string[]> {
  const dir = getCaptureStorageDir();
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.startsWith("capture-") && /\.(jpeg|png|webp)$/.test(f))
      .map((f) => path.join(dir, f))
      .sort()
      .reverse(); // Most recent first
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Delete old captures to manage disk space
 *
 * @param maxAge - Maximum age in milliseconds (default: 7 days)
 * @param maxCount - Maximum number of captures to keep (default: 1000)
 */
export async function cleanupOldCaptures(
  maxAge: number = 7 * 24 * 60 * 60 * 1000,
  maxCount: number = 1000
): Promise<number> {
  logger.info({ maxAge, maxCount }, "Starting cleanup of old captures");

  const dir = getCaptureStorageDir();
  let deletedCount = 0;

  try {
    const files = await fs.readdir(dir);
    const captureFiles = files.filter(
      (f) => f.startsWith("capture-") && /\.(jpeg|png|webp)$/.test(f)
    );

    // Sort by name (which includes timestamp)
    captureFiles.sort().reverse();

    const now = Date.now();

    for (let i = 0; i < captureFiles.length; i++) {
      const filepath = path.join(dir, captureFiles[i]);

      // Delete if over max count
      if (i >= maxCount) {
        await fs.unlink(filepath);
        deletedCount++;
        continue;
      }

      // Check file age
      try {
        const stat = await fs.stat(filepath);
        if (now - stat.mtimeMs > maxAge) {
          await fs.unlink(filepath);
          deletedCount++;
        }
      } catch {
        // Skip files we can't stat
      }
    }

    if (deletedCount > 0) {
      logger.info({ deletedCount }, "Cleaned up old captures");
    }

    return deletedCount;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ error }, "Failed to cleanup old captures");
    }
    return 0;
  }
}

/**
 * Cleanup captures older than 1 day - used in development mode
 * This helps keep the dev environment clean during frequent restarts
 */
export async function cleanupDevCaptures(): Promise<number> {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  logger.info("Dev mode: cleaning up captures older than 1 day");
  return cleanupOldCaptures(ONE_DAY_MS, 1000);
}
