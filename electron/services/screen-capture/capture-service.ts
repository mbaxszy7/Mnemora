/**
 * CaptureService - Screen capture with multi-monitor support using node-screenshots + sharp
 */

import { screen } from "electron";
import { Monitor as NodeMonitor, Image as NodeImage } from "node-screenshots";
import sharp from "sharp";
import type { CaptureSource, CaptureOptions, CaptureResult, MonitorInfo } from "./types";
import { DEFAULT_CAPTURE_OPTIONS } from "./types";
import { getLogger } from "../logger";

const logger = getLogger("capture-service");

export interface ICaptureService {
  captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult>;
  getMonitorLayout(): MonitorInfo[];
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
  getMonitorLayout(): MonitorInfo[] {
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    const layout = displays.map((display) => ({
      id: display.id.toString(),
      name: `Display ${display.id}`,
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
      isPrimary: display.id === primaryDisplay.id,
    }));

    logger.info(
      {
        displayCount: displays.length,
        primaryDisplayId: primaryDisplay.id,
        displays: displays.map((d) => ({
          id: d.id,
          bounds: d.bounds,
          scaleFactor: d.scaleFactor,
          rotation: d.rotation,
          internal: d.internal,
        })),
      },
      "Monitor layout from Electron screen module"
    );

    return layout;
  }

  /** Capture all screens and stitch them together if multiple monitors */
  async captureScreens(options?: Partial<CaptureOptions>): Promise<CaptureResult> {
    const opts = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const timestamp = Date.now();

    const monitors = NodeMonitor.all();

    // Log all available monitors with their IDs and properties
    logger.info(
      {
        monitorCount: monitors.length,
        monitors: monitors.map((m) => ({
          id: m.id,
          name: m.name,
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
          scaleFactor: m.scaleFactor,
          isPrimary: m.isPrimary,
          // Check if this might be a virtual display (unusual dimensions or position)
          isVirtual: m.width === 0 || m.height === 0 || m.name?.toLowerCase().includes("virtual"),
        })),
      },
      "Available monitors for capture"
    );

    if (monitors.length === 0) {
      logger.error("No monitors available for capture");
      throw new CaptureError("No monitors available for capture", "NO_MONITORS");
    }

    // Capture all monitors in parallel
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

    // If only one monitor or stitching disabled, return single capture
    if (successfulCaptures.length === 1 || !opts.stitchMultiMonitor) {
      const capture = successfulCaptures[0];
      const buffer = await this.convertImage(capture.image, opts);

      logger.debug(
        {
          monitorId: capture.monitor.id,
          monitorName: capture.monitor.name,
          width: capture.image.width,
          height: capture.image.height,
        },
        "Single monitor capture completed"
      );

      return {
        buffer,
        width: capture.image.width,
        height: capture.image.height,
        timestamp,
        sources: this.monitorsToSources(monitors.slice(0, 1)),
        isComposite: false,
      };
    }

    // Stitch multiple monitors together
    return this.stitchCaptures(successfulCaptures, monitors, opts, timestamp);
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
      logger.debug({ monitor: monitorInfo }, "Attempting to capture monitor");
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

  private async stitchCaptures(
    captures: Array<{ monitor: NodeMonitor; image: NodeImage }>,
    allMonitors: NodeMonitor[],
    options: CaptureOptions,
    timestamp: number
  ): Promise<CaptureResult> {
    // Calculate the bounding box of all monitors
    const bounds = this.calculateBoundingBox(captures.map((c) => c.monitor));

    // Create composite image inputs for sharp
    const compositeInputs = await Promise.all(
      captures.map(async (capture) => {
        const pngBuffer = await capture.image.toPng();
        return {
          input: pngBuffer,
          // Position relative to the bounding box origin
          left: capture.monitor.x - bounds.minX,
          top: capture.monitor.y - bounds.minY,
        };
      })
    );

    // Create the composite image using sharp
    const composite = sharp({
      create: {
        width: bounds.width,
        height: bounds.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    }).composite(compositeInputs);

    // Convert to the requested format
    const buffer = await this.applyFormat(composite, options);

    return {
      buffer,
      width: bounds.width,
      height: bounds.height,
      timestamp,
      sources: this.monitorsToSources(allMonitors),
      isComposite: true,
    };
  }

  calculateBoundingBox(monitors: NodeMonitor[]): {
    minX: number;
    minY: number;
    width: number;
    height: number;
  } {
    if (monitors.length === 0) {
      return { minX: 0, minY: 0, width: 0, height: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const monitor of monitors) {
      minX = Math.min(minX, monitor.x);
      minY = Math.min(minY, monitor.y);
      maxX = Math.max(maxX, monitor.x + monitor.width);
      maxY = Math.max(maxY, monitor.y + monitor.height);
    }

    return {
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY,
    };
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

  private monitorsToSources(monitors: NodeMonitor[]): CaptureSource[] {
    return monitors.map((monitor) => ({
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
    }));
  }
}
