/**
 * CaptureSourceProvider - Provides access to capture sources (screens/windows) with caching
 *
 * Uses hybrid strategy on macOS: Electron desktopCapturer + AppleScript for cross-Space support
 *
 * Caching strategy:
 * - Both getScreensSources() and getWindowsSources() use time-based caching (3 seconds)
 * - getWindowsSources() additionally caches based on appSourceIds parameter
 */

import { desktopCapturer, type SourcesOptions } from "electron";
import type { VisibleSource } from "./types";
import { DEFAULT_CACHE_INTERVAL } from "./types";
import { getActiveAppsOnAllSpaces } from "./macos-window-helper";
import { getLogger } from "../logger";
// import { windowFilter } from "./window-filter";

const logger = getLogger("capture-source-provider");

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class CaptureSourceProvider {
  private readonly cacheInterval: number;

  // Time-based cache for screens
  private screensCache: CacheEntry<VisibleSource[]> | null = null;

  // Time-based + param-based cache for windows
  // Key is the sorted appSourceIds joined, or empty string for no params
  private windowsCache: Map<string, CacheEntry<VisibleSource[]>> = new Map();

  constructor(cacheInterval: number = DEFAULT_CACHE_INTERVAL) {
    this.cacheInterval = cacheInterval;
  }

  private isCacheValid(timestamp: number): boolean {
    return Date.now() - timestamp < this.cacheInterval;
  }

  private getWindowsCacheKey(appSourceIds?: string[]): string {
    if (!appSourceIds || appSourceIds.length === 0) {
      return "";
    }
    return [...appSourceIds].sort().join("|");
  }

  async getScreensSources(): Promise<VisibleSource[]> {
    // Check if cache is valid
    if (this.screensCache && this.isCacheValid(this.screensCache.timestamp)) {
      logger.debug("Returning cached screens sources");
      return this.screensCache.data;
    }

    logger.debug("Fetching fresh screens sources");
    const options: SourcesOptions = {
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    };

    const sources = await desktopCapturer.getSources(options);
    const result = sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: "screen" as const,
      displayId: source.display_id || undefined,
      isVisible: true,
    }));

    // Update cache
    this.screensCache = {
      data: result,
      timestamp: Date.now(),
    };

    return result;
  }

  async getWindowsSources(appSourceIds?: string[]): Promise<VisibleSource[]> {
    const cacheKey = this.getWindowsCacheKey(appSourceIds);

    // Check if cache is valid for this specific key
    const cached = this.windowsCache.get(cacheKey);
    if (cached && this.isCacheValid(cached.timestamp)) {
      logger.debug({ cacheKey }, "Returning cached windows sources");
      return cached.data;
    }

    logger.debug({ cacheKey, appSourceIds }, "Fetching fresh windows sources");

    try {
      let result: VisibleSource[];

      if (appSourceIds && appSourceIds.length > 0) {
        const activeAppsOnAllSpaces = await getActiveAppsOnAllSpaces();
        const visibleSources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        });

        logger.info({ activeAppsOnAllSpaces }, "Active apps on all spaces");

        result = appSourceIds.map((id) => {
          let isVisible = false;
          let name = "Unknown";

          // if (id.startsWith("virtual-window:")) {
          //   const appNameMatch = id.match(/virtual-window:\d+-(.+)$/);
          //   if (appNameMatch) {
          //     name = decodeURIComponent(appNameMatch[1]);

          //     logger.info(`Virtual window name: ${name}`);

          //     // Enhanced visibility check: app is visible if it has windows on ANY space
          //     if (activeAppsOnAllSpaces.length > 0) {
          //       const appNameLower = name.toLowerCase();
          //       const hasWindowsOnAnySpace = activeAppsOnAllSpaces.some(
          //         (activeApp) =>
          //           activeApp.includes(appNameLower) &&
          //           (windowFilter.isImportantApp(appNameLower) ||
          //             windowFilter.isImportantApp(activeApp))
          //       );

          //       if (hasWindowsOnAnySpace) {
          //         isVisible = true;
          //         logger.info(`Virtual window has windows on some space: ${id} -> ${name}`);
          //       } else {
          //         logger.info(`Virtual window has no windows on any space: ${id} -> ${name}`);
          //       }
          //     } else {
          //       // Fallback: if we can't detect apps with windows, assume visible
          //       isVisible = true;
          //       logger.info(
          //         `Virtual window assumed visible (no space detection): ${id} -> ${name}`
          //       );
          //     }
          //   }
          // } else {
          // For regular window IDs, check if they're actually visible
          const visibleSource = visibleSources.find((s) => s.id === id);
          if (visibleSource) {
            isVisible = true;
            name = visibleSource.name;
            logger.info(`Regular window found visible: ${id} -> ${name}`);
          } else {
            logger.info(`Regular window NOT visible: ${id}`);
          }
          // }

          return { id, isVisible, name, type: "window" as const };
        });
      } else {
        const options: SourcesOptions = {
          types: ["window"],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        };

        const sources = await desktopCapturer.getSources(options);
        result = sources.map((source) => ({
          id: source.id,
          name: source.name,
          type: "window" as const,
          isVisible: true,
        }));
      }

      // Update cache
      this.windowsCache.set(cacheKey, {
        data: result,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      logger.error({ error }, "Failed to get windows sources:");
      return [];
    }
  }

  /**
   * Clear all caches - useful for forcing a refresh
   */
  clearCache(): void {
    this.screensCache = null;
    this.windowsCache.clear();
    logger.debug("All caches cleared");
  }
}
