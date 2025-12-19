/**
 * macOS Window Helper - AppleScript integration for cross-Space window detection
 *
 * Uses a simplified approach: only detect which apps have visible windows,
 * then use that to supplement Electron's desktopCapturer results.
 */

import { exec } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { promisify } from "util";
import { app } from "electron";
import type { CaptureSource } from "./types";
import { getLogger } from "../logger";
import { windowFilter } from "./window-filter";

const execAsync = promisify(exec);
const logger = getLogger("macos-window-helper");

interface MacWindowInfo {
  appName: string;
  windowTitle: string;
  windowId?: number;
}

interface VisibilityInfo {
  appsWithWindows: Set<string>;
  frontmostApp?: string;
}

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

/**
 * Get detailed macOS windows using Python/Quartz for accurate app detection
 * This method properly identifies Electron-based apps like Windsurf, VSCode, Kiro
 */
async function getMacWindows(): Promise<MacWindowInfo[]> {
  if (!isMacOS()) {
    return [];
  }

  try {
    // Determine path to Python executable based on environment
    // In dev: app.getAppPath() returns project root
    // In production: use process.resourcesPath
    const basePath = app.isPackaged
      ? path.join(process.resourcesPath, "bin", "window_inspector")
      : path.join(
          app.getAppPath(),
          "externals",
          "python",
          "window_inspector",
          "dist",
          "window_inspector"
        );

    const exePath = path.join(basePath, "window_inspector");

    logger.debug({ exePath, isPackaged: app.isPackaged }, "Using Python window inspector");

    if (!existsSync(exePath)) {
      logger.warn({ exePath }, "Python window inspector executable not found, skipping");
      return [];
    }

    const { stdout, stderr } = await execAsync(`"${exePath}"`, {
      timeout: 20000,
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 10,
    });

    if (!stdout || !stdout.trim()) {
      if (stderr && stderr.trim()) {
        logger.warn({ stderr }, "Python window inspector returned empty stdout");
      }
      return [];
    }

    // Parse JSON output from Python script
    const windows = JSON.parse(stdout) as Array<{
      windowId: number;
      appName: string;
      windowTitle: string;
      bounds: { X: number; Y: number; Width: number; Height: number };
      isOnScreen: boolean;
      layer: number;
      isImportant: boolean;
      area: number;
    }>;

    const results: MacWindowInfo[] = windows.map((w) => ({
      appName: w.appName,
      windowTitle: w.windowTitle,
      windowId: w.windowId,
    }));

    logger.info({ windowCount: results.length }, "Python window inspector completed");
    return results;
  } catch (error) {
    // Handle SIGINT/SIGTERM gracefully - these indicate the process was interrupted
    if (error && typeof error === "object" && "signal" in error) {
      if (error.signal === "SIGINT" || error.signal === "SIGTERM") {
        logger.warn(
          {
            signal: error.signal,
            code: (error as { code?: number }).code,
            killed: "killed" in error ? (error as { killed?: boolean }).killed : undefined,
            timeout: "killed" in error ? (error as { killed?: boolean }).killed : undefined,
          },
          "Python window inspector was interrupted, returning empty result"
        );
        return [];
      }

      // Handle timeout errors
      if ("killed" in error && error.killed && error.signal) {
        logger.warn({ signal: error.signal, timeout: true }, "Python window inspector timed out");
        return [];
      }
    }

    logger.error({ error }, "Failed to get macOS windows via Python inspector");
    return [];
  }
}

async function getVisibleAppsAndFrontmost(): Promise<VisibilityInfo> {
  if (!isMacOS()) {
    return { appsWithWindows: new Set<string>() };
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
  set frontmostApp to name of first application process whose frontmost is true
  return (my list_to_string(visibleApps, ",")) & "|||_DELIM_|" & frontmostApp
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
      timeout: 5000, // increased timeout
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 5, // 5MB buffer
    });

    if (!stdout || !stdout.trim()) {
      return { appsWithWindows: new Set<string>() };
    }

    const [appsRaw, frontmost] = stdout.trim().split("|||_DELIM_|");
    const appsWithWindows = new Set(
      (appsRaw || "")
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length > 0)
    );

    logger.info(
      { appCount: appsWithWindows.size, frontmost: frontmost?.trim() },
      "Visible apps across Spaces (AppleScript)"
    );

    return { appsWithWindows, frontmostApp: frontmost?.trim() };
  } catch (error) {
    // Handle interruption signals gracefully
    if (error && typeof error === "object" && "signal" in error) {
      if (error.signal === "SIGINT" || error.signal === "SIGTERM") {
        logger.warn({ signal: error.signal }, "Visible apps AppleScript was interrupted");
        return { appsWithWindows: new Set<string>() };
      }
    }

    logger.error({ error }, "Failed to get visible apps via AppleScript");
    return { appsWithWindows: new Set<string>() };
  }
}

/**
 * Get all windows using hybrid approach (Electron + AppleScript)
 */
export async function getHybridWindowSources(
  electronSources: CaptureSource[]
): Promise<CaptureSource[]> {
  const macWindows = await getMacWindows();
  return electronSources
    .map((source) => {
      if (source.type === "screen") return source;
      const matchedMapwindow = macWindows.find(
        (w) => w.windowId === parseInt(source.id.split(":")[1], 10)
      );
      if (!matchedMapwindow) return null;
      if (windowFilter.isSystemApp(matchedMapwindow.appName)) return null;
      if (windowFilter.isMnemoraDevInstance(matchedMapwindow.appName, matchedMapwindow.windowTitle))
        return null;
      return {
        ...source,
        name: source.name,
        windowTitle: matchedMapwindow.windowTitle,
        appName: matchedMapwindow.appName,
      };
    })
    .filter((source): source is CaptureSource => source !== null);

  // try {
  //   const macWindows = await getMacWindows();

  //   // Fast path: if AppleScript failed, fall back
  //   if (!macWindows.length) {
  //     logger.warn("No macOS windows from AppleScript, using electron sources only");
  //     return electronSources;
  //   }

  //   const visibilityInfo = await getVisibleAppsAndFrontmost();

  //   // Create a map to store real app names (source.name -> appName)
  //   //match by windowTitle against source.name
  //   const realAppNames = new Map<string, string>();

  //   // First pass: Match Python windows to desktopCapturer sources by window ID
  //   // desktopCapturer ID format: "window:{kCGWindowNumber}:0"
  //   // This is more accurate than matching by title (avoids Chrome tabs with same title)
  //   for (const macWindow of macWindows) {
  //     const macApp = macWindow.appName;
  //     const windowId = macWindow.windowId;

  //     if (!windowId) continue;

  //     // Find matching desktopCapturer source by window ID
  //     const matchingSource = electronSources.find((source) => {
  //       if (source.type === "screen") return false;
  //       // Extract window number from source.id (format: "window:12345:0")
  //       const match = source.id.match(/^window:(\d+):/);
  //       if (!match) return false;
  //       return parseInt(match[1], 10) === windowId;
  //     });

  //     if (matchingSource) {
  //       realAppNames.set(matchingSource.name, macApp);
  //       logger.debug(
  //         { sourceName: matchingSource.name, appName: macApp, windowId },
  //         "Matched source to app by window ID"
  //       );
  //     }
  //   }

  //   logger.info(
  //     { matchedCount: realAppNames.size, totalMacWindows: macWindows.length },
  //     "First pass: matched desktopCapturer sources to real app names"
  //   );

  //   // Second pass: Build merged sources with correct app names
  //   const merged: (CaptureSource & { appName?: string; appIcon?: string })[] = [];

  //   // Process all electron sources and apply real app names
  //   for (const source of electronSources) {
  //     if (source.type === "screen") {
  //       continue;
  //     }

  //     // Use real app name if available, otherwise keep the original name
  //     const realApp = realAppNames.get(source.name);
  //     const appName = realApp || source.name;

  //     merged.push({
  //       ...source,
  //       name: source.name, // Keep original window title
  //       appName: appName,
  //       appIcon: source?.appIcon ?? "",
  //     });
  //   }

  //   // Third pass: add virtual sources for windows missing in Electron list
  //   for (const macWindow of macWindows) {
  //     const macTitle = macWindow.windowTitle.toLowerCase();
  //     const macApp = macWindow.appName;

  //     // Skip if we already have this window
  //     const alreadyExists = merged.some((source) => {
  //       const sourceTitle = source.name.toLowerCase();
  //       return (
  //         sourceTitle === macTitle ||
  //         sourceTitle.includes(macTitle) ||
  //         macTitle.includes(sourceTitle)
  //       );
  //     });

  //     if (alreadyExists) continue;

  //     // Skip system apps and Mnemora dev instance
  //     if (windowFilter.isSystemApp(macApp)) continue;
  //     if (windowFilter.isMnemoraDevInstance(macApp, macWindow.windowTitle)) continue;

  //     const isImportantApp = windowFilter.isImportantApp(macApp);

  //     // Create virtual source
  //     const virtualSource: CaptureSource & {
  //       appName?: string;
  //       isVisible?: boolean;
  //       isVirtual?: boolean;
  //       appIcon?: string;
  //     } = {
  //       id: `virtual-window:${macWindow.windowId || Date.now()}-${encodeURIComponent(macApp)}`,
  //       name: buildWindowDisplayName(macWindow),
  //       type: "window",
  //       appName: macApp,
  //       isVirtual: true,
  //     };

  //     // Visibility via AppleScript list
  //     if (visibilityInfo.appsWithWindows.size > 0) {
  //       const targetNorm = windowFilter.normalize(macApp);
  //       const hasWindow = Array.from(visibilityInfo.appsWithWindows).some(
  //         (app) => app.includes(targetNorm) || targetNorm.includes(app)
  //       );
  //       virtualSource.isVisible = hasWindow;
  //     } else {
  //       virtualSource.isVisible = true;
  //     }

  //     // Try to get appIcon from desktopCapturer
  //     const matchingDesktop = windowFilter.matchDesktopSourceByApp(macApp, electronSources);
  //     if (matchingDesktop?.appIcon) {
  //       virtualSource.appIcon = matchingDesktop.appIcon;
  //     }

  //     // Include if important app or has a title
  //     if (macWindow.windowTitle || isImportantApp) {
  //       merged.push(virtualSource);
  //     }
  //   }

  //   // Deduplicate by normalized name
  //   const dedupedMap = new Map<string, CaptureSource & { appName?: string }>();
  //   for (const source of merged) {
  //     const key = windowFilter.normalize(source.name);
  //     if (!dedupedMap.has(key)) {
  //       dedupedMap.set(key, source);
  //     }
  //   }

  //   const result = Array.from(dedupedMap.values());

  //   logger.info(
  //     {
  //       result,
  //       virtualCount: result.filter((s) => s.id.startsWith("virtual-window:")).length,
  //     },
  //     "Hybrid window sources built"
  //   );

  //   return result;
  // } catch (error) {
  //   logger.error({ error }, "Failed to get hybrid window sources");
  //   return electronSources;
  // }
}

export async function getActiveAppsOnAllSpaces() {
  let activeAppsOnAllSpaces: string[] = [];
  if (isMacOS()) {
    try {
      const visibilityInfo = await getVisibleAppsAndFrontmost();
      activeAppsOnAllSpaces = [...visibilityInfo.appsWithWindows];
    } catch (error) {
      logger.error({ error }, "Could not get apps with windows");
      // Fallback to assume all apps are visible
      activeAppsOnAllSpaces = [];
    }
  }
  return activeAppsOnAllSpaces;
}
