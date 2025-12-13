import { CapturePreferences, AppInfo } from "../../shared/capture-source-types";
import { findPopularApp, DEFAULT_APP_ICON } from "../../shared/popular-apps";
import { getLogger } from "./logger";
import type { CaptureSource } from "./screen-capture/types";
import { windowFilter } from "./screen-capture/window-filter";

/**
 * Result of computing effective capture sources
 */
export interface EffectiveCaptureResult {
  /** Effective screen IDs to capture */
  screenIds: string[];
  /** Effective app names to capture */
  appNames: string[];
  /** Whether screens fell back to all (selected screens unavailable) */
  screenFallback: boolean;
  /** Whether apps fell back to all (selected apps not active) */
  appFallback: boolean;
}

/**
 * Service for managing capture source preferences
 * Handles user preferences for screen and application selection
 * Preferences are stored in memory (session-level) by default
 */
export class CapturePreferencesService {
  private preferences: CapturePreferences;
  private logger = getLogger("capture-preferences-service");

  constructor() {
    this.preferences = {
      selectedScreenIds: [],
      selectedAppNames: [],
      rememberSelection: false,
    };

    this.logger.info("CapturePreferencesService initialized with default preferences");
  }

  /**
   * Get current capture preferences (deep copy to prevent external mutation)
   * @returns Current preferences
   */
  getPreferences(): CapturePreferences {
    this.logger.info({ preferences: this.preferences }, "Getting current preferences");
    return {
      selectedScreenIds: [...this.preferences.selectedScreenIds],
      selectedAppNames: [...this.preferences.selectedAppNames],
      rememberSelection: this.preferences.rememberSelection,
    };
  }

  /**
   * Update capture preferences
   * @param prefs - Partial preferences to update
   */
  setPreferences(prefs: Partial<CapturePreferences>): void {
    const oldPreferences = this.getPreferences();

    // Update preferences with provided values (deep copy arrays)
    this.preferences = {
      selectedScreenIds: prefs.selectedScreenIds
        ? [...prefs.selectedScreenIds]
        : this.preferences.selectedScreenIds,
      selectedAppNames: prefs.selectedAppNames
        ? [...prefs.selectedAppNames]
        : this.preferences.selectedAppNames,
      rememberSelection: prefs.rememberSelection ?? this.preferences.rememberSelection,
    };

    this.logger.info(
      {
        oldPreferences,
        newPreferences: this.preferences,
        updatedFields: Object.keys(prefs),
      },
      "Preferences updated"
    );
  }

  /**
   * Compute effective capture sources based on current preferences and available sources
   * Handles fallback logic when selected sources are unavailable
   *
   * @param availableScreenIds - List of currently available screen IDs
   * @param windows - List of currently available windows (used to compute active apps)
   * @returns Effective capture sources with fallback flags
   */
  getEffectiveCaptureSources(
    availableScreenIds: string[],
    windows: CaptureSource[]
  ): EffectiveCaptureResult {
    const activeAppNames = this.getActiveApps(windows).map((app) => app.name);
    // Compute effective screens
    const effectiveScreens = this.computeEffectiveScreens(availableScreenIds);

    // Compute effective apps
    const effectiveApps = this.computeEffectiveApps(activeAppNames);

    const result: EffectiveCaptureResult = {
      screenIds: effectiveScreens.ids,
      appNames: effectiveApps.names,
      screenFallback: effectiveScreens.fallback,
      appFallback: effectiveApps.fallback,
    };

    this.logger.info(
      {
        preferences: {
          selectedScreenIds: this.preferences.selectedScreenIds,
          selectedAppNames: this.preferences.selectedAppNames,
        },
        available: { screenIds: availableScreenIds, appNames: activeAppNames },
        effective: result,
      },
      "Computed effective capture sources"
    );

    // Log fallback events at info level
    if (result.screenFallback) {
      this.logger.info(
        {
          selectedScreenIds: this.preferences.selectedScreenIds,
          availableScreenIds,
        },
        "Screen fallback triggered: none of the selected screens are available, capturing all screens"
      );
    }

    if (result.appFallback) {
      this.logger.info(
        {
          selectedAppNames: this.preferences.selectedAppNames,
          activeAppNames,
        },
        "App fallback triggered: none of the selected apps are active, capturing all apps"
      );
    }

    return result;
  }

  /**
   * Compute effective screens to capture
   * Falls back to all screens if:
   * - No screens are selected (empty = capture all)
   * - None of the selected screens are available (e.g., external monitor disconnected)
   */
  private computeEffectiveScreens(availableScreenIds: string[]): {
    ids: string[];
    fallback: boolean;
  } {
    // Empty selection means capture all
    if (this.preferences.selectedScreenIds.length === 0) {
      return { ids: [...availableScreenIds], fallback: false };
    }

    // Find intersection of selected and available screens
    const effectiveIds = this.preferences.selectedScreenIds.filter((id) =>
      availableScreenIds.includes(id)
    );

    // If no selected screens are available, fallback to all
    if (effectiveIds.length === 0) {
      return { ids: [...availableScreenIds], fallback: true };
    }

    return { ids: effectiveIds, fallback: false };
  }

  /**
   * Compute effective apps to capture
   * Falls back to all apps if:
   * - No apps are selected (empty = capture all)
   * - None of the selected apps are currently active
   */
  private computeEffectiveApps(activeAppNames: string[]): {
    names: string[];
    fallback: boolean;
  } {
    // Empty selection means capture all
    if (this.preferences.selectedAppNames.length === 0) {
      return { names: [...activeAppNames], fallback: false };
    }

    // Find intersection of selected and active apps
    const effectiveNames = this.preferences.selectedAppNames.filter((name) =>
      activeAppNames.includes(name)
    );

    // If no selected apps are active, fallback to all
    if (effectiveNames.length === 0) {
      return { names: [...activeAppNames], fallback: true };
    }

    return { names: effectiveNames, fallback: false };
  }

  /**
   * Reset preferences to default values
   */
  resetPreferences(): void {
    const oldPreferences = this.getPreferences();

    this.preferences = {
      selectedScreenIds: [],
      selectedAppNames: [],
      rememberSelection: false,
    };

    this.logger.info(
      {
        oldPreferences,
        newPreferences: this.preferences,
      },
      "Preferences reset to defaults"
    );
  }

  /**
   * Match an app name to a popular app and get its icon
   * Returns the icon path and whether it's a popular app
   *
   * Requirements: 2.2, 2.5
   */
  matchAppIcon(appName: string): { icon: string; isPopular: boolean } {
    const popularApp = findPopularApp(appName);
    if (popularApp) {
      return {
        icon: popularApp.config.icon,
        isPopular: true,
      };
    }
    return {
      icon: DEFAULT_APP_ICON,
      isPopular: false,
    };
  }

  /**
   * Sort apps with popular apps first, then alphabetically
   *
   * Requirements: 8.1
   */
  sortApps(apps: AppInfo[]): AppInfo[] {
    return [...apps].sort((a, b) => {
      // Popular apps come first
      if (a.isPopular && !b.isPopular) return -1;
      if (!a.isPopular && b.isPopular) return 1;
      // Then sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get active applications with icons
   * Groups windows by app name and matches with popular apps
   *
   * Requirements: 2.1, 2.2, 2.5, 8.1
   */
  getActiveApps(windows: CaptureSource[]): AppInfo[] {
    try {
      // Group windows by app name and count
      const appWindowCounts = new Map<string, number>();
      for (const window of windows) {
        const appName = windowFilter.getDisplayAppName(window);
        appWindowCounts.set(appName, (appWindowCounts.get(appName) || 0) + 1);
      }

      // Convert to AppInfo array
      const apps: AppInfo[] = [];
      for (const [name, windowCount] of appWindowCounts) {
        const { icon, isPopular } = this.matchAppIcon(name);
        apps.push({
          name,
          icon,
          isPopular,
          windowCount,
        });
      }

      // Sort with popular apps first
      const sortedApps = this.sortApps(apps);

      this.logger.info(
        {
          totalApps: sortedApps.length,
          popularApps: sortedApps.filter((a) => a.isPopular).length,
          totalWindows: windows.length,
        },
        "Active apps retrieved"
      );

      return sortedApps;
    } catch (error) {
      this.logger.error({ error }, "Failed to get active apps");
      return [];
    }
  }
}
