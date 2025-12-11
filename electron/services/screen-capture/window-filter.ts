/**
 * WindowFilter - Filters system windows and normalizes app names
 */

import type { CaptureSource, WindowFilterConfig } from "./types";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "./types";

export interface IWindowFilter {
  filterSystemWindows(sources: CaptureSource[]): CaptureSource[];
  normalizeAppName(name: string): string;
  shouldExclude(source: CaptureSource): boolean;
  getDisplayAppName(source: { name: string; appName?: string }): string;
}

export class WindowFilter implements IWindowFilter {
  private readonly config: WindowFilterConfig;
  private readonly aliasToCanonical: Map<string, string>;
  private readonly systemWindowsLower: Set<string>;

  constructor(config: Partial<WindowFilterConfig> = {}) {
    this.config = {
      systemWindows: config.systemWindows ?? DEFAULT_WINDOW_FILTER_CONFIG.systemWindows,
      appAliases: config.appAliases ?? DEFAULT_WINDOW_FILTER_CONFIG.appAliases,
    };

    // Build reverse lookup map: alias -> canonical name
    this.aliasToCanonical = new Map();
    for (const [canonical, aliases] of Object.entries(this.config.appAliases)) {
      for (const alias of aliases) {
        this.aliasToCanonical.set(alias.toLowerCase(), canonical);
      }
    }

    // Pre-compute lowercase set for efficient matching
    this.systemWindowsLower = new Set(this.config.systemWindows.map((w) => w.toLowerCase()));
  }

  normalizeAppName(name: string): string {
    const lowerName = name.toLowerCase().trim();
    return this.aliasToCanonical.get(lowerName) ?? name;
  }

  /**
   * Get display-friendly app name from a capture source.
   * Prefers appName field (from AppleScript on macOS) over window name.
   */
  getDisplayAppName(source: { name: string; appName?: string }): string {
    if (source.appName) {
      return source.appName;
    }
    return source.name;
  }

  private isSystemWindow(source: CaptureSource): boolean {
    // Check window name - exact match
    const normalizedName = this.normalizeAppName(source.name).toLowerCase();
    if (
      this.systemWindowsLower.has(normalizedName) ||
      this.systemWindowsLower.has(source.name.toLowerCase())
    ) {
      return true;
    }

    // Also check appName if available (from AppleScript on macOS) - exact match
    if (source.appName) {
      const normalizedAppName = this.normalizeAppName(source.appName).toLowerCase();
      if (
        this.systemWindowsLower.has(normalizedAppName) ||
        this.systemWindowsLower.has(source.appName.toLowerCase())
      ) {
        return true;
      }
    }

    // Check if window name ends with a system window name (e.g., "file.ts — Mnemora")
    const nameLower = source.name.toLowerCase();
    for (const sysWindow of this.systemWindowsLower) {
      // Check if window name ends with " - SystemWindow" or " — SystemWindow"
      if (nameLower.endsWith(` - ${sysWindow}`) || nameLower.endsWith(` — ${sysWindow}`)) {
        return true;
      }
    }

    return false;
  }

  private isMinimized(source: CaptureSource): boolean {
    if (source.type !== "window") {
      return false;
    }
    if (!source.bounds) {
      return false;
    }
    return source.bounds.width <= 0 || source.bounds.height <= 0;
  }

  shouldExclude(source: CaptureSource): boolean {
    // Only filter windows, not screens
    if (source.type !== "window") {
      return false;
    }
    return this.isSystemWindow(source) || this.isMinimized(source);
  }

  filterSystemWindows(sources: CaptureSource[]): CaptureSource[] {
    return sources.filter((source) => {
      if (source.type !== "window") {
        return true; // Keep screens
      }
      return !this.isSystemWindow(source);
    });
  }
}
