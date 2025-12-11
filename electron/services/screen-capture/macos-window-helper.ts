/**
 * macOS Window Helper - AppleScript integration for cross-Space window detection
 *
 * Uses a simplified approach: only detect which apps have visible windows,
 * then use that to supplement Electron's desktopCapturer results.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { CaptureSource } from "./types";
import { DEFAULT_WINDOW_FILTER_CONFIG } from "./types";
import { getLogger } from "../logger";

const execAsync = promisify(exec);
const logger = getLogger("macos-window-helper");

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

/**
 * Get list of app names that have visible windows across all Spaces
 * This is much simpler and more reliable than getting detailed window info
 */
export async function getAppsWithWindows(): Promise<string[]> {
  if (!isMacOS()) {
    return [];
  }

  const script = `
tell application "System Events"
  set visibleApps to {}
  repeat with p in (every application process)
    try
      if (count of windows of p) > 0 then
        set end of visibleApps to (name of p as string)
      end if
    end try
  end repeat
  return my list_to_string(visibleApps, "|||")
end tell
on list_to_string(lst, delim)
  set AppleScript's text item delimiters to delim
  set str to lst as string
  set AppleScript's text item delimiters to ""
  return str
end list_to_string
`;

  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
    });

    if (!stdout || !stdout.trim()) {
      return [];
    }

    // Parse comma-separated app names
    const apps = stdout
      .trim()
      .split("|||")
      .map((app) => app.trim())
      .filter((app) => app.length > 0);

    logger.info({ appCount: apps.length, apps }, "Apps with windows across all Spaces");

    return apps;
  } catch (error) {
    logger.error({ error }, "Failed to get apps with windows via AppleScript");
    return [];
  }
}

/**
 * Build a bidirectional alias map from the config
 * e.g., "Google Chrome" -> ["chrome"] becomes both "google chrome" -> ["chrome"] and "chrome" -> ["google chrome"]
 */
function buildAliasMap(appAliases: Record<string, string[]>): Record<string, string[]> {
  const aliasMap: Record<string, string[]> = {};

  for (const [canonical, aliases] of Object.entries(appAliases)) {
    const canonicalLower = canonical.toLowerCase();

    // Add canonical -> aliases mapping
    aliasMap[canonicalLower] = aliases.map((a) => a.toLowerCase());

    // Add reverse mappings: alias -> [canonical, other aliases]
    for (const alias of aliases) {
      const aliasLower = alias.toLowerCase();
      if (!aliasMap[aliasLower]) {
        aliasMap[aliasLower] = [];
      }
      // Add canonical name
      if (!aliasMap[aliasLower].includes(canonicalLower)) {
        aliasMap[aliasLower].push(canonicalLower);
      }
      // Add other aliases
      for (const otherAlias of aliases) {
        const otherLower = otherAlias.toLowerCase();
        if (otherLower !== aliasLower && !aliasMap[aliasLower].includes(otherLower)) {
          aliasMap[aliasLower].push(otherLower);
        }
      }
    }
  }

  return aliasMap;
}

// Pre-build the alias map from config
const APP_ALIAS_MAP = buildAliasMap(DEFAULT_WINDOW_FILTER_CONFIG.appAliases);

/**
 * Try to find the app name for a window by matching against the list of apps with windows
 * Uses fuzzy matching to handle cases where window title contains app name
 */
export function findAppNameForWindow(
  windowTitle: string,
  appsWithWindows: string[]
): string | undefined {
  if (!windowTitle || appsWithWindows.length === 0) {
    return undefined;
  }

  const titleLower = windowTitle.toLowerCase().trim();

  // Check if window title contains any known app name
  for (const appName of appsWithWindows) {
    const appLower = appName.toLowerCase();
    if (titleLower.includes(appLower) || appLower.includes(titleLower)) {
      return appName;
    }

    // Check aliases
    const aliases = APP_ALIAS_MAP[appLower] || [];
    for (const alias of aliases) {
      if (titleLower.includes(alias)) {
        return appName;
      }
    }
  }

  return undefined;
}

/**
 * Extract app name from window title using common patterns
 * Handles formats like:
 * - "Document - AppName" (e.g., "index.html - VS Code")
 * - "AppName - Subtitle" (e.g., "Mnemora - Your Second Brain")
 * - "Document — AppName" (em dash variant)
 */
export function extractAppNameFromTitle(windowTitle: string): string {
  if (!windowTitle) {
    return windowTitle;
  }

  // Try splitting by " - " or " — "
  let parts = windowTitle.split(" - ");
  if (parts.length === 1) {
    parts = windowTitle.split(" — ");
  }

  if (parts.length <= 1) {
    return windowTitle;
  }

  // For window titles with separators, we need to determine which part is the app name
  // Common patterns:
  // - "filename.ext - AppName" -> last part is app name
  // - "AppName - Subtitle/Description" -> first part is app name
  //
  // Heuristic: if the first part looks like a filename (has extension), use last part
  // Otherwise, use first part (likely "AppName - Subtitle" format)
  const firstPart = parts[0].trim();
  const lastPart = parts[parts.length - 1].trim();

  // Check if first part looks like a filename (contains a dot followed by extension)
  const hasFileExtension = /\.\w{1,10}$/.test(firstPart);

  if (hasFileExtension) {
    // "filename.ext - AppName" format
    return lastPart;
  }

  // Check if last part is a known app name pattern (short, no special chars)
  // This handles "Document - VS Code" style
  if (lastPart.length < 25 && !/[_.]/.test(lastPart)) {
    return lastPart;
  }

  // Default to first part for "AppName - Subtitle" format
  return firstPart;
}

/**
 * Check if an app name matches any of the apps with visible windows
 * Uses fuzzy matching to handle name variations
 */
export function isAppVisible(appName: string, appsWithWindows: string[]): boolean {
  if (appsWithWindows.length === 0) {
    // If we couldn't detect, assume visible
    return true;
  }

  const appNameLower = appName.toLowerCase();

  return appsWithWindows.some((activeApp) => {
    const activeAppLower = activeApp.toLowerCase();

    // Direct match
    if (activeAppLower.includes(appNameLower) || appNameLower.includes(activeAppLower)) {
      return true;
    }

    // Check aliases from config
    const appAliases = APP_ALIAS_MAP[appNameLower] || [];
    return appAliases.some(
      (alias) => activeAppLower.includes(alias) || alias.includes(activeAppLower)
    );
  });
}

/** Merge Electron and AppleScript sources, removing duplicates */
export function mergeSources(
  electronSources: CaptureSource[],
  appleScriptSources: CaptureSource[]
): CaptureSource[] {
  // Create a map of existing sources by normalized name for deduplication
  const sourceMap = new Map<string, CaptureSource>();

  // Add Electron sources first (they have proper IDs for capture)
  for (const source of electronSources) {
    const key = normalizeSourceKey(source);
    sourceMap.set(key, source);
  }

  // Add AppleScript sources that don't already exist
  for (const source of appleScriptSources) {
    const key = normalizeSourceKey(source);
    if (!sourceMap.has(key)) {
      sourceMap.set(key, source);
    }
  }

  return Array.from(sourceMap.values());
}

function normalizeSourceKey(source: CaptureSource): string {
  return `${source.type}:${source.name.toLowerCase().trim()}`;
}

/**
 * Create virtual CaptureSource entries for apps that have windows on other Spaces
 * These can be used to show the user what's available, even if not directly capturable
 */
export function createVirtualSourcesForApps(
  appsWithWindows: string[],
  existingSourceNames: Set<string>
): CaptureSource[] {
  const virtualSources: CaptureSource[] = [];

  for (const appName of appsWithWindows) {
    // Check if we already have a source for this app
    const hasExisting = Array.from(existingSourceNames).some((name) => {
      const nameLower = name.toLowerCase();
      const appLower = appName.toLowerCase();
      return nameLower.includes(appLower) || appLower.includes(nameLower);
    });

    if (!hasExisting) {
      virtualSources.push({
        id: `virtual-window:${Date.now()}-${encodeURIComponent(appName)}`,
        name: appName,
        type: "window",
      });
    }
  }

  return virtualSources;
}

/** Get all windows using hybrid approach (Electron + AppleScript) */
export async function getHybridWindowSources(
  electronSources: CaptureSource[]
): Promise<CaptureSource[]> {
  if (!isMacOS()) {
    return electronSources;
  }

  try {
    // Get list of apps with windows (fast, reliable)
    const appsWithWindows = await getAppsWithWindows();

    // Enrich electron sources with app names by matching window titles against app list
    const enrichedSources = electronSources.map((source) => {
      if (source.type !== "window") {
        return source;
      }

      // Try to find the app name for this window
      const appName = findAppNameForWindow(source.name, appsWithWindows);
      if (appName) {
        return { ...source, appName };
      }

      return source;
    });

    // Create virtual sources for apps on other Spaces
    const existingNames = new Set(enrichedSources.map((s) => s.name));
    const virtualSources = createVirtualSourcesForApps(appsWithWindows, existingNames);

    // For virtual sources, the name IS the app name
    const enrichedVirtualSources = virtualSources.map((source) => ({
      ...source,
      appName: source.name,
    }));

    const mergedSources = mergeSources(enrichedSources, enrichedVirtualSources);

    return mergedSources;
  } catch (error) {
    logger.error({ error }, "Failed to get hybrid window sources");
    return electronSources;
  }
}
