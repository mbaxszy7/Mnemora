import { describe, it, expect } from "vitest";
import { contextRulesStore } from "./context-rules-store";

describe("contextRulesStore", () => {
  it("returns default snapshot initially", () => {
    const snap = contextRulesStore.getSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.markdown).toBe("");
    expect(snap.updatedAt).toBeNull();
  });

  it("updates from user settings", () => {
    contextRulesStore.updateFromUserSettings({
      contextRulesEnabled: true,
      contextRulesMarkdown: "# Rules",
      contextRulesUpdatedAt: 12345,
    });

    const snap = contextRulesStore.getSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.markdown).toBe("# Rules");
    expect(snap.updatedAt).toBe(12345);
  });

  it("overwrites previous state on update", () => {
    contextRulesStore.updateFromUserSettings({
      contextRulesEnabled: true,
      contextRulesMarkdown: "old",
      contextRulesUpdatedAt: 1,
    });
    contextRulesStore.updateFromUserSettings({
      contextRulesEnabled: false,
      contextRulesMarkdown: "new",
      contextRulesUpdatedAt: 2,
    });

    const snap = contextRulesStore.getSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.markdown).toBe("new");
    expect(snap.updatedAt).toBe(2);
  });
});
