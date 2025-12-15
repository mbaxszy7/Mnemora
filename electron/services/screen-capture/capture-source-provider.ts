/**
 * CaptureSourceProvider - Provides access to capture sources (screens/windows) with caching
 *
 * Uses hybrid strategy on macOS: Electron desktopCapturer + AppleScript for cross-Space support
 */

import { desktopCapturer, type SourcesOptions } from "electron";
import { AutoRefreshCache, type IAutoRefreshCache } from "./auto-refresh-cache";
import type { VisibleSource, CaptureSourceFilter } from "./types";
import { DEFAULT_CACHE_INTERVAL } from "./types";
// import { getHybridWindowSources } from "./macos-window-helper";
// import { getLogger } from "../logger";
// import { AppInfo } from "@shared/capture-source-types";
// import { isPopularApp } from "@shared/popular-apps";

// const logger = getLogger("capture-source-provider");

export interface ICaptureSourceProvider {
  getSources(filter?: CaptureSourceFilter): VisibleSource[];
  refresh(): Promise<void>;
  dispose(): void;
  // getActiveApps(): AppInfo[];
}

export interface CaptureSourceProviderOptions {
  cacheInterval?: number;
  immediate?: boolean;
  onError?: (error: Error) => void;
}

export class CaptureSourceProvider implements ICaptureSourceProvider {
  private readonly cache: IAutoRefreshCache<VisibleSource[]>;
  private disposed = false;

  constructor(options: CaptureSourceProviderOptions = {}) {
    const cacheInterval = options.cacheInterval ?? DEFAULT_CACHE_INTERVAL;
    const immediate = options.immediate ?? true;

    this.cache = new AutoRefreshCache<VisibleSource[]>({
      fetchFn: () => this.fetchSources(),
      interval: cacheInterval,
      immediate,
      onError: options.onError,
    });
  }

  private async fetchSources(): Promise<VisibleSource[]> {
    const options: SourcesOptions = {
      types: ["screen", "window"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    };

    const sources = await desktopCapturer.getSources(options);

    const electronSources = sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.display_id ? "screen" : "window",
      displayId: source.display_id || undefined,
    })) as VisibleSource[];
    return electronSources;
  }

  getSources(filter?: CaptureSourceFilter): VisibleSource[] {
    const sources = this.cache.get() ?? [];

    if (!filter) {
      return sources;
    }

    return this.filterSources(sources, filter);
  }

  private filterSources(sources: VisibleSource[], filter: CaptureSourceFilter): VisibleSource[] {
    let filtered = [...sources];

    // Filter by type
    if (filter.type && filter.type !== "all") {
      filtered = filtered.filter((source) => source.type === filter.type);
    }

    return filtered;
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

  // private sortApps(apps: AppInfo[]): AppInfo[] {
  //   return [...apps].sort((a, b) => {
  //     // Popular apps come first
  //     const aPopular = isPopularApp(a.name);
  //     const bPopular = isPopularApp(b.name);
  //     if (aPopular && !bPopular) return -1;
  //     if (!aPopular && bPopular) return 1;
  //     // Then sort alphabetically by name
  //     return a.name.localeCompare(b.name);
  //   });
  // }

  // getActiveApps(): AppInfo[] {
  //   const windows = this.getWindows();
  //   return windows.map((window) => ({
  //     id: window.id,
  //     name: window.name ?? "",
  //     appIcon: window.appIcon ?? null,
  //   }));
  // try {
  //   // Group windows by app name and count
  //   const appWindowCounts = new Map<string, number>();
  //   for (const window of windows) {
  //     if (!window.appName) continue;
  //     appWindowCounts.set(window.appName, (appWindowCounts.get(window.appName) || 0) + 1);
  //   }

  //   // Convert to AppInfo array (icon/isPopular computed on frontend)
  //   const apps: AppInfo[] = [];
  //   for (const [name, windowCount] of appWindowCounts) {
  //     apps.push({ name, windowCount });
  //   }

  //   // Sort with popular apps first
  //   const sortedApps = this.sortApps(apps);

  //   logger.info(
  //     {
  //       sortedApps,
  //       totalWindows: windows,
  //     },
  //     "Active apps retrieved"
  //   );

  //   return sortedApps;
  // } catch (error) {
  //   logger.error({ error }, "Failed to get active apps");
  //   return [];
  // }
  // }
}
