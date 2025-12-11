/**
 * CaptureSourceProvider - Provides access to capture sources (screens/windows) with caching
 *
 * Uses hybrid strategy on macOS: Electron desktopCapturer + AppleScript for cross-Space support
 */

import { desktopCapturer, type SourcesOptions } from "electron";
import { AutoRefreshCache, type IAutoRefreshCache } from "./auto-refresh-cache";
import type { CaptureSource, CaptureSourceFilter } from "./types";
import { DEFAULT_CACHE_INTERVAL } from "./types";
import { isMacOS, getHybridWindowSources } from "./macos-window-helper";
import { getLogger } from "../logger";

const logger = getLogger("capture-source-provider");

export interface ICaptureSourceProvider {
  getSources(filter?: CaptureSourceFilter): CaptureSource[];
  getScreens(): CaptureSource[];
  getWindows(): CaptureSource[];
  refresh(): Promise<void>;
  dispose(): void;
}

export interface CaptureSourceProviderOptions {
  cacheInterval?: number;
  immediate?: boolean;
  onError?: (error: Error) => void;
}

export class CaptureSourceProvider implements ICaptureSourceProvider {
  private readonly cache: IAutoRefreshCache<CaptureSource[]>;
  private disposed = false;

  constructor(options: CaptureSourceProviderOptions = {}) {
    const cacheInterval = options.cacheInterval ?? DEFAULT_CACHE_INTERVAL;
    const immediate = options.immediate ?? true;

    this.cache = new AutoRefreshCache<CaptureSource[]>({
      fetchFn: () => this.fetchSources(),
      interval: cacheInterval,
      immediate,
      onError: options.onError,
    });
  }

  /** Fetch capture sources, merging with AppleScript on macOS for cross-Space support */
  private async fetchSources(): Promise<CaptureSource[]> {
    logger.debug("Fetching capture sources");

    // Use minimal thumbnail size for metadata-only fetching
    const options: SourcesOptions = {
      types: ["screen", "window"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    };

    const sources = await desktopCapturer.getSources(options);
    logger.debug({ electronSourceCount: sources.length }, "Got sources from desktopCapturer");

    const electronSources = sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.id.startsWith("screen:") ? "screen" : "window",
      displayId: source.display_id || undefined,
      appIcon: source.appIcon || undefined,
    })) as CaptureSource[];

    // On macOS, merge with AppleScript results to capture windows across all Spaces
    // Requirement 8.1, 8.2: Use hybrid approach for macOS compatibility
    if (isMacOS()) {
      logger.debug("macOS detected, merging with AppleScript sources");
      const merged = await getHybridWindowSources(electronSources);
      logger.info(
        {
          electronCount: electronSources.length,
          mergedCount: merged.length,
        },
        "Fetched and merged capture sources"
      );
      return merged;
    }

    logger.info({ sourceCount: electronSources.length }, "Fetched capture sources");
    return electronSources;
  }

  getSources(filter?: CaptureSourceFilter): CaptureSource[] {
    const sources = this.cache.get() ?? [];

    if (!filter) {
      return sources;
    }

    return this.filterSources(sources, filter);
  }

  filterSources(sources: CaptureSource[], filter: CaptureSourceFilter): CaptureSource[] {
    let filtered = [...sources];

    // Filter by type
    if (filter.type && filter.type !== "all") {
      filtered = filtered.filter((source) => source.type === filter.type);
    }

    return filtered;
  }

  getScreens(): CaptureSource[] {
    return this.getSources({ type: "screen" });
  }

  getWindows(): CaptureSource[] {
    return this.getSources({ type: "window" });
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.cache.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.cache.dispose();
  }
}
