import type { UserSettings } from "@shared/user-settings-types";

export type ContextRulesSnapshot = {
  enabled: boolean;
  markdown: string;
  updatedAt: number | null;
};

class ContextRulesStore {
  private snapshot: ContextRulesSnapshot = {
    enabled: false,
    markdown: "",
    updatedAt: null,
  };

  getSnapshot(): ContextRulesSnapshot {
    return this.snapshot;
  }

  updateFromUserSettings(
    settings: Pick<
      UserSettings,
      "contextRulesEnabled" | "contextRulesMarkdown" | "contextRulesUpdatedAt"
    >
  ): void {
    this.snapshot = {
      enabled: settings.contextRulesEnabled,
      markdown: settings.contextRulesMarkdown,
      updatedAt: settings.contextRulesUpdatedAt,
    };
  }
}

export const contextRulesStore = new ContextRulesStore();
