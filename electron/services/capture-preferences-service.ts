import { CapturePreferences } from "../../shared/capture-source-types";
import { getLogger } from "./logger";

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

  getEffectiveCaptureSources() {
    const result = {
      selectedScreens: this.preferences.selectedScreens,
      selectedApps: this.preferences.selectedApps,
    };

    return result;
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
