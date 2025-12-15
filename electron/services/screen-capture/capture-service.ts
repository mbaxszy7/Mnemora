/**
 * CaptureService - Screen capture with multi-monitor support using desktopCapturer + sharp
 */

import { desktopCapturer, screen } from "electron";
import sharp from "sharp";
import type { CaptureOptions, CaptureResult } from "./types";
import type { CapturePreferences, ScreenInfo, AppInfo } from "../../../shared/capture-source-types";
import { DEFAULT_CAPTURE_OPTIONS } from "./types";
import { getLogger } from "../logger";
import { windowFilter } from "./window-filter";

const logger = getLogger("capture-service");

export interface ICaptureService {
  captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult[]>;
  captureWindowsByApp(
    selectedInfo: CapturePreferences,
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
    selectedInfo: CapturePreferences,
    options?: Partial<CaptureOptions>
  ): Promise<CaptureResult[]> {
    const opts = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const timestamp = Date.now();

    // logger.info({ selectedApps }, "Capturing windows by app names");

    // Get all window sources with high resolution thumbnails
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
      return selectedInfo.selectedApps.some((app) => app.id === source.id);
    });

    logger.info(
      {
        matchedCount: targetSources.length,
        matchedNames: targetSources.map((s) => s.name),
      },
      "Filtered windows by app names"
    );

    if (targetSources.length === 0) {
      logger.warn({ selectedInfo }, "No windows found for specified apps");
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
    // todo: mac platform cross-space window detection, and should handle capture window by app with such virtual id

    // Filter out empty thumbnails (minimized windows)
    const windows: AppInfo[] = sources
      .filter((source) => !source.thumbnail.isEmpty())
      .map((source) => ({
        id: source.id,
        name: source.name,
        type: "window" as const,
        appIcon: source.appIcon ? source.appIcon.toDataURL() : "",
      }));

    logger.info({ windowCount: windows.length }, "App info retrieved");

    return windowFilter.filterSystemWindows(windows);
  }
}
