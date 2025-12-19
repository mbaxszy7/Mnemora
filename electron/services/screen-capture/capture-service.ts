/**
 * CaptureService - Screen capture with multi-monitor support using desktopCapturer + sharp
 */

import { desktopCapturer, screen } from "electron";
import sharp from "sharp";
import type { CaptureOptions, CaptureResult } from "./types";
import type { ScreenInfo, AppInfo } from "../../../shared/capture-source-types";
import { DEFAULT_CAPTURE_OPTIONS, DEFAULT_WINDOW_FILTER_CONFIG } from "./types";
import { getLogger } from "../logger";
import { windowFilter } from "./window-filter";
import { getHybridWindowSources, isMacOS } from "./macos-window-helper";
import type { CaptureSource } from "./types";

const logger = getLogger("capture-service");

const APP_NAME_DELIMITERS = /[-–—|｜:·•]/;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordBoundaries(source: string, index: number, length: number): boolean {
  const before = index === 0 ? " " : source[index - 1];
  const after = index + length >= source.length ? " " : source[index + length];
  const boundary = /[^a-z0-9]/i;
  return boundary.test(before) && boundary.test(after);
}

/**
 * Parse desktopCapturer source.name (mainly on non-mac platforms) to extract
 * canonical appName and windowTitle for known apps (APP_ALIASES list).
 * For other apps we leave the name as-is.
 */
function formatAppName(sourceName: string): { appName: string; windowTitle?: string } | null {
  const lowerName = sourceName.toLowerCase();
  let bestMatch: { canonical: string; alias: string; index: number } | null = null;

  for (const [canonical, aliases] of Object.entries(DEFAULT_WINDOW_FILTER_CONFIG.appAliases)) {
    const candidates = [canonical, ...aliases];
    for (const candidate of candidates) {
      const candidateLower = candidate.toLowerCase();
      const idx = lowerName.indexOf(candidateLower);
      if (idx === -1) continue;
      if (!hasWordBoundaries(sourceName, idx, candidate.length)) continue;
      if (!bestMatch || candidate.length > bestMatch.alias.length) {
        bestMatch = { canonical, alias: candidate, index: idx };
      }
    }
  }

  if (!bestMatch) return null;

  const aliasPattern = escapeRegExp(bestMatch.alias.trim());
  const leading = new RegExp(`^${aliasPattern}\\s*${APP_NAME_DELIMITERS.source}\\s*(.+)$`, "i");
  const trailing = new RegExp(`^(.+?)\\s*${APP_NAME_DELIMITERS.source}\\s*${aliasPattern}$`, "i");

  let windowTitle: string | undefined;
  const trimmed = sourceName.trim();

  if (leading.test(trimmed)) {
    windowTitle = trimmed.replace(leading, "$1").trim();
  } else if (trailing.test(trimmed)) {
    windowTitle = trimmed.replace(trailing, "$1").trim();
  } else if (trimmed.toLowerCase() === bestMatch.alias.toLowerCase()) {
    windowTitle = undefined;
  }

  // Avoid empty subtitles
  if (windowTitle && windowTitle.length === 0) {
    windowTitle = undefined;
  }

  return {
    appName: bestMatch.canonical,
    windowTitle,
  };
}

export interface ICaptureService {
  captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult[]>;
  captureWindowsByApp(
    appSourceIds: string[],
    options?: Partial<CaptureOptions>
  ): Promise<CaptureResult[]>;
  getCaptureScreenInfo(): Promise<ScreenInfo[]>;
  getCaptureAppInfo(): Promise<AppInfo[]>;
}

export class CaptureError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export class CaptureService implements ICaptureService {
  /** Capture all screens, each screen as a separate image */
  async captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult[]> {
    const opts = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const timestamp = Date.now();

    // Get all screen sources with high resolution thumbnails
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 },
    });

    if (sources.length === 0) {
      logger.error("No screens available for capture");
      throw new CaptureError("No screens available for capture", "NO_SCREENS");
    }

    // Filter by selectedScreenIds if provided
    let targetSources = sources;
    if (opts.selectedScreenIds && opts.selectedScreenIds.length > 0) {
      targetSources = sources.filter((s) => opts.selectedScreenIds!.includes(s.display_id));
      // Fall back to all screens if no match
      if (targetSources.length === 0) {
        targetSources = sources;
      }
    }

    const displays = screen.getAllDisplays();

    // Convert each screen to CaptureResult
    const results: CaptureResult[] = [];

    for (const source of targetSources) {
      try {
        const thumbnail = source.thumbnail;

        // Skip empty thumbnails
        if (thumbnail.isEmpty()) {
          logger.debug({ sourceName: source.name }, "Skipping empty screen thumbnail");
          continue;
        }

        // Convert NativeImage to PNG buffer, then apply format with sharp
        const pngBuffer = thumbnail.toPNG();
        const sharpInstance = sharp(pngBuffer);
        const buffer = await this.applyFormat(sharpInstance, opts);

        // Find matching display for bounds info
        const matchedDisplay = displays.find((d) => d.id.toString() === source.display_id);

        results.push({
          buffer,
          timestamp,
          source: {
            id: source.id,
            name: source.name,
            type: "screen",
            displayId: source.display_id,
            bounds: matchedDisplay?.bounds,
          },
        });
      } catch (error) {
        logger.warn(
          {
            sourceName: source.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to capture screen"
        );
      }
    }

    if (results.length === 0) {
      logger.error("All screen captures failed");
      throw new CaptureError("All screen captures failed", "ALL_CAPTURES_FAILED");
    }

    logger.info(
      {
        capturedScreens: results.length,
        screenIds: results.map((r) => r.source.displayId),
      },
      "All screen captures completed"
    );

    return results;
  }

  private async applyFormat(sharpInstance: sharp.Sharp, options: CaptureOptions): Promise<Buffer> {
    switch (options.format) {
      case "jpeg":
        return sharpInstance.jpeg({ quality: options.quality }).toBuffer();
      case "webp":
        return sharpInstance.webp({ quality: options.quality }).toBuffer();
      case "png":
      default:
        return sharpInstance.png().toBuffer();
    }
  }

  async captureWindowsByApp(
    appSourceIds: string[],
    options?: Partial<CaptureOptions>
  ): Promise<CaptureResult[]> {
    const opts = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const timestamp = Date.now();
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1280, height: 720 },
      fetchWindowIcons: false,
    });

    logger.info(
      {
        totalSources: sources.length,
        sourceNames: sources.map((s) => s.name),
      },
      "Retrieved window sources"
    );

    // Filter windows by app name (case-insensitive partial match)
    const targetSources = sources.filter((source) => {
      return appSourceIds.includes(source.id);
    });

    logger.info(
      {
        matchedCount: targetSources.length,
        matchedNames: targetSources.map((s) => s.name),
      },
      "Filtered windows by app names"
    );

    if (targetSources.length === 0) {
      logger.warn("No windows found for specified apps");
      return [];
    }

    // Convert each window to CaptureResult
    const results: CaptureResult[] = [];

    for (const source of targetSources) {
      try {
        const thumbnail = source.thumbnail;

        // Skip empty thumbnails (minimized windows)
        if (thumbnail.isEmpty()) {
          logger.debug({ sourceName: source.name }, "Skipping empty thumbnail");
          continue;
        }

        // Convert NativeImage to PNG buffer, then apply format with sharp
        const pngBuffer = thumbnail.toPNG();
        const sharpInstance = sharp(pngBuffer);
        const buffer = await this.applyFormat(sharpInstance, opts);

        logger.info(
          {
            sourceId: source.id,
            sourceName: source.name,
            display_id: source.display_id,
          },
          "Window capture completed"
        );

        results.push({
          buffer,
          timestamp,
          source: {
            id: source.id,
            name: source.name,
            type: "window",
          },
        });

        logger.debug(
          {
            sourceId: source.id,
            sourceName: source.name,
            bufferSize: buffer.length,
          },
          "Window capture completed"
        );
      } catch (error) {
        logger.warn(
          {
            sourceName: source.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to capture window"
        );
      }
    }

    logger.info(
      {
        capturedWindows: results.length,
        windowIds: results.map((r) => r.source.id),
      },
      "All window captures completed"
    );

    return results;
  }

  /**
   * Get capture screen information with thumbnails
   * Merges data from desktopCapturer and screen.getAllDisplays()
   */
  async getCaptureScreenInfo(): Promise<ScreenInfo[]> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    // Build ScreenInfo array
    const screens: ScreenInfo[] = sources.map((source, index) => {
      const displayIdFromSource = source.display_id;
      let matchedDisplay = displays.find((d) => d.id.toString() === displayIdFromSource);

      // Fallback: match by index if display_id doesn't match
      if (!matchedDisplay && index < displays.length) {
        matchedDisplay = displays[index];
      }

      const display = matchedDisplay || displays[0];
      const isPrimary = display ? display.id === primaryDisplay.id : false;
      const actualDisplayId = display?.id.toString() || "";

      return {
        id: source.id,
        name: source.name,
        type: "screen" as const,
        bounds: display?.bounds || { x: 0, y: 0, width: 0, height: 0 },
        displayId: actualDisplayId,
        isPrimary,
        thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : "",
      };
    });

    // Ensure at least one screen is marked as primary
    const hasPrimary = screens.some((s) => s.isPrimary);
    if (!hasPrimary && screens.length > 0) {
      screens[0].isPrimary = true;
    }

    logger.info(
      {
        screenCount: screens.length,
        primaryScreen: screens.find((s) => s.isPrimary)?.name,
      },
      "Screen info retrieved with thumbnails"
    );

    return screens;
  }

  /**
   * Get capture application/window information with icons
   */
  async getCaptureAppInfo(): Promise<AppInfo[]> {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    // Map Electron sources into internal structure (keep even minimized for macOS cross-Space detection)
    const electronSources: (CaptureSource & {
      appIcon?: string | null;
      appName?: string;
    })[] = sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: "window",
      appIcon: source.appIcon ? source.appIcon.toDataURL() : "",
      // Leave appName undefined; mac hybrid helper may populate/normalize it
    }));

    // On macOS, enrich with cross-Space windows (virtual ids) via AppleScript helper (no Python dependency)
    const hybridSources = isMacOS()
      ? await getHybridWindowSources(electronSources)
      : electronSources;

    // On non-mac, try to parse known apps from source.name to derive canonical appName/windowTitle
    const normalizedSources = !isMacOS()
      ? hybridSources.map((source) => {
          const parsed = formatAppName(source.name);
          if (!parsed) return source;
          return {
            ...source,
            appName: parsed.appName,
            windowTitle: parsed.windowTitle,
          };
        })
      : hybridSources;

    const windows: AppInfo[] = normalizedSources
      .map((source) => {
        const appName = source.appName;
        const originalName = source.name;
        const parsedWindowTitle = source.windowTitle;
        // Use appName as display name, fall back to original name
        const name = appName || originalName;
        // Keep original window title for subtitle (only if different from appName)
        const windowTitle =
          parsedWindowTitle ?? (appName && originalName !== appName ? originalName : undefined);
        // Validate appIcon - must have actual base64 content, not just the prefix
        const rawIcon = source.appIcon ?? "";
        const appIcon = rawIcon.length > 50 ? rawIcon : ""; // Empty base64 prefix is ~22 chars

        return {
          id: source.id,
          name,
          type: "window" as const,
          appIcon,
          windowTitle,
        };
      })
      // Filter out unnamed entries
      .filter((w) => !!w.name && w.name.trim().length > 0);

    const filtered = windowFilter.filterSystemWindows(windows);

    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));

    logger.info(
      {
        hybridSources,
      },
      "App info retrieved (mac hybrid cross-space)"
    );

    return sorted;
  }
}
