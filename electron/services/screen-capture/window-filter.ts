/**
 * WindowFilter - Filters system windows and normalizes app names
 */

import { DEFAULT_WINDOW_FILTER_CONFIG } from "./types";

/** Common properties needed for window filtering */
interface FilterableSource {
  name: string;
  type: "screen" | "window";
}

export interface IWindowFilter {
  filterSystemWindows<T extends FilterableSource>(sources: T[]): T[];
}

class WindowFilter implements IWindowFilter {
  private readonly aliasToCanonical: Map<string, string>;
  private readonly systemWindowsLower: Set<string>;

  constructor() {
    // Build reverse lookup map: alias -> canonical name
    this.aliasToCanonical = new Map();
    for (const [canonical, aliases] of Object.entries(DEFAULT_WINDOW_FILTER_CONFIG.appAliases)) {
      for (const alias of aliases) {
        this.aliasToCanonical.set(alias.toLowerCase(), canonical);
      }
    }

    // Pre-compute lowercase set for efficient matching
    this.systemWindowsLower = new Set(
      DEFAULT_WINDOW_FILTER_CONFIG.systemWindows.map((w) => w.toLowerCase())
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
}

// Export singleton instance
export const windowFilter = new WindowFilter();
