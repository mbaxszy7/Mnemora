/**
 * WindowFilter - Filters system windows and normalizes app names
 */

import { CaptureSource, DEFAULT_WINDOW_FILTER_CONFIG } from "./types";

/** Common properties needed for window filtering */
interface FilterableSource {
  name: string;
  type: "screen" | "window";
}

export interface IWindowFilter {
  filterSystemWindows<T extends FilterableSource>(sources: T[]): T[];
  isImportantApp(name: string): boolean;
  isSystemApp(appName: string): boolean;
  isMnemoraDevInstance(appName: string, windowTitle: string): boolean;
  normalize(str: string): string;
  matchDesktopSourceByApp(
    appName: string,
    desktopSources: CaptureSource[]
  ): CaptureSource | undefined;
}

class WindowFilter implements IWindowFilter {
  private readonly aliasToCanonical: Map<string, string>;
  private readonly systemWindowsLower: Set<string>;
  private readonly importantAppsLower: Set<string>;

  constructor() {
    // Build reverse lookup map: alias -> canonical name
    this.aliasToCanonical = new Map();
    for (const [canonical, aliases] of Object.entries(DEFAULT_WINDOW_FILTER_CONFIG.appAliases)) {
      this.aliasToCanonical.set(canonical.toLowerCase(), canonical);
      for (const alias of aliases) {
        this.aliasToCanonical.set(alias.toLowerCase(), canonical);
      }
    }

    // Pre-compute lowercase set for efficient matching
    this.systemWindowsLower = new Set(
      DEFAULT_WINDOW_FILTER_CONFIG.systemWindows.map((w) => w.toLowerCase())
    );

    // Build important app set (already includes aliases from config)
    this.importantAppsLower = new Set(
      (DEFAULT_WINDOW_FILTER_CONFIG.importantApps ?? []).map((a) => a.toLowerCase())
    );
  }

  private normalizeAppName(name: string): string {
    const lowerName = name.toLowerCase().trim();
    return this.aliasToCanonical.get(lowerName) ?? name;
  }

  private isSystemWindow(source: FilterableSource): boolean {
    // Check window name - exact match
    const normalizedName = this.normalizeAppName(source.name).toLowerCase();
    if (
      this.systemWindowsLower.has(normalizedName) ||
      this.systemWindowsLower.has(source.name.toLowerCase())
    ) {
      return true;
    }
    return false;
  }

  filterSystemWindows<T extends FilterableSource>(sources: T[]): T[] {
    return sources.filter((source) => {
      if (source.type !== "window") {
        return true; // Keep screens
      }
      return !this.isSystemWindow(source);
    });
  }

  isImportantApp(name: string): boolean {
    const normalized = this.normalizeAppName(name).toLowerCase();
    return (
      this.importantAppsLower.has(normalized) || this.importantAppsLower.has(name.toLowerCase())
    );
  }

  normalize(str: string): string {
    return str.toLowerCase().trim();
  }

  isSystemApp(appName: string): boolean {
    return this.systemWindowsLower.has(appName.toLowerCase());
  }

  isMnemoraDevInstance(appName: string, windowTitle: string): boolean {
    if (appName.toLowerCase() === "electron") {
      return windowTitle.toLowerCase().includes("mnemora");
    }
    return appName.toLowerCase() === "mnemora";
  }

  matchDesktopSourceByApp(
    appName: string,
    desktopSources: CaptureSource[]
  ): CaptureSource | undefined {
    const appLower = this.normalize(appName);
    const canonical =
      this.aliasToCanonical.get(appLower) ??
      this.aliasToCanonical.get(appName.toLowerCase()) ??
      appName;
    const aliases = DEFAULT_WINDOW_FILTER_CONFIG.appAliases[canonical] ?? [];

    const candidates = new Set<string>([
      appLower,
      canonical.toLowerCase(),
      ...aliases.map((a) => a.toLowerCase()),
    ]);

    // Strategy 1: match any candidate contained in source name
    const found = desktopSources.find((source) => {
      const sourceNorm = this.normalize(source.name);
      return Array.from(candidates).some(
        (candidate) => sourceNorm.includes(candidate) || candidate.includes(sourceNorm)
      );
    });

    return found;
  }
}

// Export singleton instance
export const windowFilter = new WindowFilter();
