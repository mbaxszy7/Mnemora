/**
 * CaptureService - Screen capture with multi-monitor support using node-screenshots + sharp
 */

import { desktopCapturer, screen } from "electron";
import { Monitor as NodeMonitor, Image as NodeImage } from "node-screenshots";
import sharp from "sharp";
import type { CaptureSource, CaptureOptions, CaptureResult } from "./types";
import type { ScreenInfo } from "../../../shared/capture-source-types";
import { DEFAULT_CAPTURE_OPTIONS } from "./types";
import { getLogger } from "../logger";

const logger = getLogger("capture-service");

export interface ICaptureService {
  captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult[]>;
  captureWindowsByApp(
    appNames: string[],
    options?: Partial<CaptureOptions>
  ): Promise<CaptureResult[]>;
  getScreensWithThumbnails(): Promise<ScreenInfo[]>;
  getScreenIdMapping(): Promise<Map<string, string>>;
  mapScreenIdsToDisplayIds(selectedScreenIds: string[], screenInfos: ScreenInfo[]): string[];
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

    const allMonitors = NodeMonitor.all();

    if (allMonitors.length === 0) {
      logger.error("No monitors available for capture");
      throw new CaptureError("No monitors available for capture", "NO_MONITORS");
    }

    // Filter monitors by screenIds if provided
    // screenIds are CGDirectDisplayID as strings (e.g., "1", "2")
    let monitors = allMonitors;
    if (opts.screenIds && opts.screenIds.length > 0) {
      monitors = allMonitors.filter((m) => opts.screenIds!.includes(m.id.toString()));

      // If no monitors match the filter, fall back to all monitors
      if (monitors.length === 0) {
        monitors = allMonitors;
      }
    }

    // Capture selected monitors in parallel
    const capturePromises = monitors.map((monitor) => this.captureMonitor(monitor));
    const captures = await Promise.all(capturePromises);

    // Filter out failed captures and log which ones failed
    const successfulCaptures = captures.filter((c): c is NonNullable<typeof c> => c !== null);
    const failedCount = captures.length - successfulCaptures.length;

    if (failedCount > 0) {
      logger.warn(
        {
          totalMonitors: monitors.length,
          successfulCaptures: successfulCaptures.length,
          failedCaptures: failedCount,
        },
        "Some monitor captures failed"
      );
    }

    if (successfulCaptures.length === 0) {
      logger.error("All monitor captures failed");
      throw new CaptureError("All monitor captures failed", "ALL_CAPTURES_FAILED");
    }

    // Convert each capture to CaptureResult
    const results: CaptureResult[] = await Promise.all(
      successfulCaptures.map(async (capture) => {
        const buffer = await this.convertImage(capture.image, opts);
        const screenId = capture.monitor.id.toString();

        logger.debug(
          {
            monitorId: capture.monitor.id,
            monitorName: capture.monitor.name,
            width: capture.image.width,
            height: capture.image.height,
          },
          "Monitor capture completed"
        );

        return {
          buffer,
          timestamp,
          source: this.monitorToSource(capture.monitor),
          screenId,
        };
      })
    );

    logger.info(
      {
        capturedScreens: results.length,
        screenIds: results.map((r) => r.screenId),
      },
      "All screen captures completed"
    );

    return results;
  }

  private async captureMonitor(
    monitor: NodeMonitor
  ): Promise<{ monitor: NodeMonitor; image: NodeImage } | null> {
    const monitorInfo = {
      id: monitor.id,
      name: monitor.name,
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
      scaleFactor: monitor.scaleFactor,
      isPrimary: monitor.isPrimary,
    };

    try {
      logger.info({ monitor: monitorInfo }, "Attempting to capture monitor");
      const image = await monitor.captureImage();
      logger.debug(
        {
          monitorId: monitor.id,
          monitorName: monitor.name,
          imageWidth: image.width,
          imageHeight: image.height,
        },
        "Monitor capture successful"
      );
      return { monitor, image };
    } catch (error) {
      // Skip failed monitors (Requirement 6.3: Handle unavailable monitors)
      // This can happen with virtual displays or displays that are not accessible
      logger.warn(
        {
          monitor: monitorInfo,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to capture monitor - may be virtual or inaccessible"
      );
      return null;
    }
  }

  private async convertImage(image: NodeImage, options: CaptureOptions): Promise<Buffer> {
    const pngBuffer = await image.toPng();
    const sharpInstance = sharp(pngBuffer);
    return this.applyFormat(sharpInstance, options);
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

  private monitorToSource(monitor: NodeMonitor): CaptureSource {
    return {
      id: `screen:${monitor.id}:0`,
      name: monitor.name || `Display ${monitor.id}`,
      type: "screen" as const,
      displayId: monitor.id.toString(),
      bounds: {
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
      },
    };
  }

  /**
   * Get screens with thumbnails and display information
   * Merges data from desktopCapturer and screen.getAllDisplays()
   *
   * ⚠️ Why not reuse CaptureSourceProvider?
   * CaptureSourceProvider uses thumbnailSize: { width: 1, height: 1 } for performance
   * (it only needs metadata, not actual thumbnails). For the settings UI, we need
   * larger thumbnails (320x180) for visual display, so we call desktopCapturer directly.
   */
  async getScreensWithThumbnails(): Promise<ScreenInfo[]> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 320, height: 180 },
    });

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    logger.debug(
      {
        sourceCount: sources.length,
        displayCount: displays.length,
        primaryDisplayId: primaryDisplay.id,
      },
      "Retrieved screen sources and displays"
    );

    const screens: ScreenInfo[] = sources.map((source, index) => {
      const displayIdFromSource = source.display_id;
      let matchedDisplay = displays.find((d) => d.id.toString() === displayIdFromSource);

      if (!matchedDisplay && index < displays.length) {
        matchedDisplay = displays[index];
      }

      const display = matchedDisplay || displays[0];
      const isPrimary = display ? display.id === primaryDisplay.id : false;
      const actualDisplayId = display?.id.toString() || "";

      return {
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        width: display?.bounds.width || 0,
        height: display?.bounds.height || 0,
        isPrimary,
        displayId: actualDisplayId,
      };
    });

    const hasPrimary = screens.some((s) => s.isPrimary);
    if (!hasPrimary && screens.length > 0) {
      screens[0].isPrimary = true;
    }

    logger.info(
      {
        screenCount: screens.length,
        primaryScreen: screens.find((s) => s.isPrimary)?.name,
      },
      "Screens retrieved with thumbnails"
    );

    return screens;
  }

  /**
   * Get the current screen list with displayId mapping
   * This is useful for mapping desktopCapturer IDs to node-screenshots IDs
   */
  async getScreenIdMapping(): Promise<Map<string, string>> {
    const screens = await this.getScreensWithThumbnails();
    const mapping = new Map<string, string>();

    for (const s of screens) {
      if (s.displayId) {
        mapping.set(s.id, s.displayId);
      }
    }

    return mapping;
  }

  /**
   * Map desktopCapturer screen IDs to displayIds (CGDirectDisplayID)
   *
   * This function is used when filtering screens for capture based on user preferences.
   * User preferences store desktopCapturer IDs (for thumbnail association), but
   * CaptureService needs displayIds (CGDirectDisplayID) for node-screenshots filtering.
   *
   * @param selectedScreenIds - Array of desktopCapturer IDs (e.g., ["screen:0:0", "screen:1:0"])
   * @param screenInfos - Array of ScreenInfo objects with both id and displayId
   * @returns Array of displayIds (CGDirectDisplayID) for use with node-screenshots
   */
  mapScreenIdsToDisplayIds(selectedScreenIds: string[], screenInfos: ScreenInfo[]): string[] {
    const displayIds: string[] = [];

    for (const screenId of selectedScreenIds) {
      const screenInfo = screenInfos.find((s) => s.id === screenId);
      if (screenInfo && screenInfo.displayId) {
        displayIds.push(screenInfo.displayId);
      } else {
        logger.warn(
          { screenId },
          "Could not find displayId for selected screen - screen may no longer be available"
        );
      }
    }

    return displayIds;
  }

  /**
   * Capture windows belonging to specific apps using desktopCapturer
   *
   * This method captures windows instead of screens, filtered by app name.
   * Uses Electron's desktopCapturer which provides window thumbnails.
   *
   * @param appNames - Array of app names to capture (e.g., ["Google Chrome", "Notion"])
   * @param options - Capture options (format, quality)
   * @returns Array of CaptureResult, one per captured window
   */
  async captureWindowsByApp(
    appNames: string[],
    options?: Partial<CaptureOptions>
  ): Promise<CaptureResult[]> {
    const opts = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const timestamp = Date.now();

    logger.info({ appNames }, "Capturing windows by app names");

    // Get all window sources with high resolution thumbnails
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1920, height: 1080 },
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
      const sourceName = source.name.toLowerCase();
      return appNames.some((appName) => {
        const appLower = appName.toLowerCase();
        // Match if source name contains app name or vice versa
        return sourceName.includes(appLower) || appLower.includes(sourceName.split(" ")[0]);
      });
    });

    logger.info(
      {
        matchedCount: targetSources.length,
        matchedNames: targetSources.map((s) => s.name),
      },
      "Filtered windows by app names"
    );

    if (targetSources.length === 0) {
      logger.warn({ appNames }, "No windows found for specified apps");
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

        results.push({
          buffer,
          timestamp,
          source: {
            id: source.id,
            name: source.name,
            type: "window",
            appName: source.name.split(" - ")[0], // Extract app name from window title
          },
          screenId: source.id,
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
        windowIds: results.map((r) => r.screenId),
      },
      "All window captures completed"
    );

    return results;
  }
}
