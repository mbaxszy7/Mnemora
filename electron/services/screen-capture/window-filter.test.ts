import { describe, it, expect } from "vitest";
import { windowFilter } from "./window-filter";

describe("windowFilter", () => {
  describe("normalize", () => {
    it("lowercases and trims", () => {
      expect(windowFilter.normalize("  Chrome  ")).toBe("chrome");
      expect(windowFilter.normalize("VS Code")).toBe("vs code");
    });
  });

  describe("isSystemApp", () => {
    it("detects known system windows", () => {
      expect(windowFilter.isSystemApp("Dock")).toBe(true);
      expect(windowFilter.isSystemApp("Spotlight")).toBe(true);
      expect(windowFilter.isSystemApp("Control Center")).toBe(true);
    });

    it("returns false for non-system apps", () => {
      expect(windowFilter.isSystemApp("Google Chrome")).toBe(false);
      expect(windowFilter.isSystemApp("Visual Studio Code")).toBe(false);
    });
  });

  describe("isImportantApp", () => {
    it("detects important apps", () => {
      expect(windowFilter.isImportantApp("Google Chrome")).toBe(true);
      expect(windowFilter.isImportantApp("Visual Studio Code")).toBe(true);
    });

    it("detects important apps via aliases", () => {
      expect(windowFilter.isImportantApp("chrome")).toBe(true);
      expect(windowFilter.isImportantApp("vscode")).toBe(true);
    });

    it("returns false for non-important apps", () => {
      expect(windowFilter.isImportantApp("SomeRandomApp")).toBe(false);
    });
  });

  describe("isMnemoraDevInstance", () => {
    it("detects Electron with mnemora in title", () => {
      expect(windowFilter.isMnemoraDevInstance("Electron", "Mnemora - dev")).toBe(true);
    });

    it("detects Mnemora app name", () => {
      expect(windowFilter.isMnemoraDevInstance("Mnemora", "Some title")).toBe(true);
    });

    it("returns false for other apps", () => {
      expect(windowFilter.isMnemoraDevInstance("Chrome", "Google")).toBe(false);
      expect(windowFilter.isMnemoraDevInstance("Electron", "Other app")).toBe(false);
    });
  });

  describe("filterSystemWindows", () => {
    it("keeps screen sources", () => {
      const sources = [{ name: "Screen 1", type: "screen" as const }];
      expect(windowFilter.filterSystemWindows(sources)).toHaveLength(1);
    });

    it("filters out system windows", () => {
      const sources = [
        { name: "Dock", type: "window" as const },
        { name: "Google Chrome", type: "window" as const },
      ];
      const filtered = windowFilter.filterSystemWindows(sources);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("Google Chrome");
    });
  });

  describe("matchDesktopSourceByApp", () => {
    const desktopSources = [
      { id: "1", name: "Google Chrome", type: "window" as const, appName: "Google Chrome" },
      {
        id: "2",
        name: "Visual Studio Code",
        type: "window" as const,
        appName: "Visual Studio Code",
      },
    ];

    it("matches by canonical name", () => {
      const match = windowFilter.matchDesktopSourceByApp("Google Chrome", desktopSources);
      expect(match).toBeDefined();
      expect(match!.name).toBe("Google Chrome");
    });

    it("matches by alias", () => {
      const match = windowFilter.matchDesktopSourceByApp("chrome", desktopSources);
      expect(match).toBeDefined();
      expect(match!.name).toBe("Google Chrome");
    });

    it("returns undefined for unknown app", () => {
      const match = windowFilter.matchDesktopSourceByApp("UnknownApp12345", desktopSources);
      expect(match).toBeUndefined();
    });
  });
});
