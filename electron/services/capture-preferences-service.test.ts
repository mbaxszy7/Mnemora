import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { CapturePreferencesService } from "./capture-preferences-service";

describe("CapturePreferencesService", () => {
  let service: CapturePreferencesService;

  beforeEach(() => {
    service = new CapturePreferencesService();
  });

  describe("getPreferences", () => {
    it("returns empty defaults on construction", () => {
      const prefs = service.getPreferences();
      expect(prefs).toEqual({
        selectedScreens: [],
        selectedApps: [],
      });
    });

    it("returns a defensive copy (mutations do not affect internal state)", () => {
      const prefs = service.getPreferences();
      prefs.selectedScreens.push({ displayId: "1", name: "Display 1" } as never);

      const prefs2 = service.getPreferences();
      expect(prefs2.selectedScreens).toEqual([]);
    });
  });

  describe("setPreferences", () => {
    it("updates selectedScreens when provided", () => {
      const screens = [{ displayId: "1", name: "Display 1" }];
      service.setPreferences({ selectedScreens: screens as never[] });

      const prefs = service.getPreferences();
      expect(prefs.selectedScreens).toEqual(screens);
    });

    it("updates selectedApps when provided", () => {
      const apps = [{ id: "app-1", name: "VS Code" }];
      service.setPreferences({ selectedApps: apps as never[] });

      const prefs = service.getPreferences();
      expect(prefs.selectedApps).toEqual(apps);
    });

    it("preserves selectedScreens when only selectedApps is provided", () => {
      const screens = [{ displayId: "1", name: "Display 1" }];
      service.setPreferences({ selectedScreens: screens as never[] });

      const apps = [{ id: "app-1", name: "VS Code" }];
      service.setPreferences({ selectedApps: apps as never[] });

      const prefs = service.getPreferences();
      expect(prefs.selectedScreens).toEqual(screens);
      expect(prefs.selectedApps).toEqual(apps);
    });

    it("stores a defensive copy (mutations to original do not affect state)", () => {
      const screens = [{ displayId: "1", name: "Display 1" }];
      service.setPreferences({ selectedScreens: screens as never[] });

      screens.push({ displayId: "2", name: "Display 2" });

      const prefs = service.getPreferences();
      expect(prefs.selectedScreens).toHaveLength(1);
    });
  });

  describe("getEffectiveCaptureSources", () => {
    it("returns current selected screens and apps", () => {
      const screens = [{ displayId: "1", name: "Display 1" }];
      const apps = [{ id: "app-1", name: "VS Code" }];
      service.setPreferences({
        selectedScreens: screens as never[],
        selectedApps: apps as never[],
      });

      const result = service.getEffectiveCaptureSources();
      expect(result.selectedScreens).toEqual(screens);
      expect(result.selectedApps).toEqual(apps);
    });
  });

  describe("resetPreferences", () => {
    it("resets all preferences to empty defaults", () => {
      service.setPreferences({
        selectedScreens: [{ displayId: "1", name: "Display 1" }] as never[],
        selectedApps: [{ id: "app-1", name: "VS Code" }] as never[],
      });

      service.resetPreferences();

      const prefs = service.getPreferences();
      expect(prefs).toEqual({
        selectedScreens: [],
        selectedApps: [],
      });
    });
  });
});
