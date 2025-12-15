import { CapturePreferences } from "../../shared/capture-source-types";
import { getLogger } from "./logger";
import { VisibleSource } from "./screen-capture/types";

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
      selectedScreens: [],
      selectedApps: [],
    };

    this.logger.info("CapturePreferencesService initialized with default preferences");
  }

  getPreferences(): CapturePreferences {
    // this.logger.info({ preferences: this.preferences }, "Getting current preferences");
    return {
      selectedScreens: [...this.preferences.selectedScreens],
      selectedApps: [...this.preferences.selectedApps],
    };
  }

  setPreferences(prefs: Partial<CapturePreferences>): void {
    // const oldPreferences = this.getPreferences();

    // Update preferences with provided values (deep copy arrays)
    this.preferences = {
      selectedScreens: prefs.selectedScreens
        ? [...prefs.selectedScreens]
        : this.preferences.selectedScreens,
      selectedApps: prefs.selectedApps ? [...prefs.selectedApps] : this.preferences.selectedApps,
    };

    // this.logger.info(
    //   {
    //     oldPreferences,
    //     newPreferences: this.preferences,
    //     updatedFields: Object.keys(prefs),
    //   },
    //   "Preferences updated"
    // );
  }

  getEffectiveCaptureSources(captureSources: VisibleSource[]) {
    const result = {
      selectedScreens: this.computeEffectiveScreens(captureSources),
      selectedApps: this.preferences.selectedApps,
    };

    // this.logger.info(
    //   {
    //     preferences: {
    //       selectedScreens: this.preferences.selectedScreens,
    //       selectedApps: this.preferences.selectedApps,
    //     },
    //     available: { captureSources },
    //     effective: result,
    //   },
    //   "Computed effective capture sources"
    // );

    return result;
  }

  /**
   * Compute effective screens to capture
   * Falls back to all screens if:
   * - No screens are selected (empty = capture all)
   * - None of the selected screens are available (e.g., external monitor disconnected)
   */
  private computeEffectiveScreens(availableSource: VisibleSource[]) {
    // Find intersection of selected and available screens
    const effectiveScreens = this.preferences.selectedScreens.filter((screen) =>
      availableSource.some((available) => available.id === screen.id)
    );
    return effectiveScreens;
  }

  /**
   * Compute effective apps to capture
   * Falls back to all apps if:
   * - No apps are selected (empty = capture all)
   * - None of the selected apps are currently active
   */
  private computeEffectiveApps(availableWindows: VisibleSource[]) {
    // Find intersection of selected and active apps
    const effectiveApps = this.preferences.selectedApps.filter((app) =>
      availableWindows.some((available) => available.type === "window" && app.id === available.id)
    );
    return effectiveApps;
  }

  resetPreferences(): void {
    const oldPreferences = this.getPreferences();

    this.preferences = {
      selectedScreens: [],
      selectedApps: [],
    };

    this.logger.info(
      {
        oldPreferences,
        newPreferences: this.preferences,
      },
      "Preferences reset to defaults"
    );
  }
}
