import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock electron app module
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getLocale: vi.fn(() => "en-US"),
  },
}));

// Mock i18next
const mockT = vi.fn((key: string) => key);
const mockChangeLanguage = vi.fn();
const mockI18nInstance = {
  t: mockT,
  changeLanguage: mockChangeLanguage,
  language: "en",
  use: vi.fn().mockReturnThis(),
  init: vi.fn().mockResolvedValue(undefined),
};

vi.mock("i18next", () => ({
  default: {
    createInstance: vi.fn(() => mockI18nInstance),
  },
}));

vi.mock("i18next-fs-backend", () => ({
  default: {},
}));

// Mock llm-config-service
vi.mock("./llm-config-service", () => ({
  llmConfigService: {
    loadConfiguration: vi.fn().mockResolvedValue(null),
    saveConfiguration: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger
vi.mock("./logger", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("MainI18nService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Reset mock language
    mockI18nInstance.language = "en";
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getInstance", () => {
    it("should return a singleton instance", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();

      const instance1 = MainI18nService.getInstance();
      const instance2 = MainI18nService.getInstance();

      expect(instance1).toBe(instance2);
    }, 15000);
  });

  describe("initialize", () => {
    it("should initialize i18next with correct configuration", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      await service.initialize();

      expect(mockI18nInstance.use).toHaveBeenCalled();
      expect(mockI18nInstance.init).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbackLng: "en",
          supportedLngs: ["en", "zh-CN"],
          interpolation: { escapeValue: false },
        })
      );
    }, 15000);

    it("should not reinitialize if already initialized", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();
      const initCallsBefore = mockI18nInstance.init.mock.calls.length;

      await service.initialize();
      await service.initialize();

      // init should only be called once
      expect(mockI18nInstance.init.mock.calls.length - initCallsBefore).toBe(1);
    });

    it("should set initialized flag after successful initialization", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      expect(service.isInitialized()).toBe(false);
      await service.initialize();
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe("t (translation)", () => {
    it("should return key if not initialized", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      const result = service.t("common.buttons.save");

      expect(result).toBe("common.buttons.save");
    });

    it("should call i18next t function after initialization", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      mockT.mockReturnValue("Save");
      await service.initialize();
      const result = service.t("common.buttons.save");

      expect(mockT).toHaveBeenCalledWith("common.buttons.save");
      expect(result).toBe("Save");
    });

    it("should pass options to i18next t function", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      mockT.mockReturnValue("Hello, World");
      await service.initialize();
      service.t("tray.usageToday", { count: 1 });

      expect(mockT).toHaveBeenCalledWith("tray.usageToday", { count: 1 });
    });
  });

  describe("changeLanguage", () => {
    it("should not change language if not initialized", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      await service.changeLanguage("zh-CN");

      expect(mockChangeLanguage).not.toHaveBeenCalled();
    });

    it("should call i18next changeLanguage after initialization", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      await service.initialize();
      await service.changeLanguage("zh-CN");

      expect(mockChangeLanguage).toHaveBeenCalledWith("zh-CN");
    });
  });

  describe("getCurrentLanguage", () => {
    it("should return default language if not initialized", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      const result = service.getCurrentLanguage();

      expect(result).toBe("en");
    });

    it("should return current language from i18next after initialization", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      mockI18nInstance.language = "zh-CN";
      await service.initialize();
      const result = service.getCurrentLanguage();

      expect(result).toBe("zh-CN");
    });
  });

  describe("detectSystemLanguage", () => {
    it("should return zh-CN for Chinese locale", async () => {
      const { app } = await import("electron");
      vi.mocked(app.getLocale).mockReturnValue("zh-CN");

      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      const result = service.detectSystemLanguage();

      expect(result).toBe("zh-CN");
    });

    it("should return en for English locale", async () => {
      const { app } = await import("electron");
      vi.mocked(app.getLocale).mockReturnValue("en-US");

      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      const result = service.detectSystemLanguage();

      expect(result).toBe("en");
    });

    it("should return en for unsupported locale", async () => {
      const { app } = await import("electron");
      vi.mocked(app.getLocale).mockReturnValue("fr-FR");

      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      const result = service.detectSystemLanguage();

      expect(result).toBe("en");
    });
  });

  describe("pending language", () => {
    it("should store pending language and return it from getCurrentLanguage", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      // Set language before init - should be stored as pending
      await service.changeLanguage("zh-CN");
      expect(service.getCurrentLanguage()).toBe("zh-CN");
    });

    it("should not apply pending language if it matches current after init", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      // Set pending to en (same as default init language)
      await service.changeLanguage("en");

      mockI18nInstance.language = "en";
      await service.initialize();

      // The i18next changeLanguage should NOT have been called since pending matches current
      expect(mockI18nInstance.changeLanguage).not.toHaveBeenCalled();
    });
  });

  describe("changeLanguage DB persistence", () => {
    it("should save language to DB after changing", async () => {
      const { MainI18nService } = await import("./i18n-service");
      const { llmConfigService } = await import("./llm-config-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      vi.mocked(llmConfigService.loadConfiguration).mockResolvedValue({
        mode: "unified",
        config: { baseUrl: "https://test.com", apiKey: "key", model: "m" },
        language: "en",
      });
      vi.mocked(llmConfigService.saveConfiguration).mockResolvedValue();

      await service.initialize();
      await service.changeLanguage("zh-CN");

      expect(llmConfigService.saveConfiguration).toHaveBeenCalled();
    });

    it("should handle DB save error gracefully", async () => {
      const { MainI18nService } = await import("./i18n-service");
      const { llmConfigService } = await import("./llm-config-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      // First call succeeds (during initialize), second fails (during changeLanguage)
      vi.mocked(llmConfigService.loadConfiguration)
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("DB error"));

      await service.initialize();
      // Should not throw
      await service.changeLanguage("zh-CN");
    });

    it("should handle null config from DB gracefully", async () => {
      const { MainI18nService } = await import("./i18n-service");
      const { llmConfigService } = await import("./llm-config-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      vi.mocked(llmConfigService.loadConfiguration).mockResolvedValue(null);

      await service.initialize();
      await service.changeLanguage("zh-CN");

      // Should NOT have called save since config is null
      expect(llmConfigService.saveConfiguration).not.toHaveBeenCalled();
    });
  });

  describe("t edge cases", () => {
    it("should handle array key before initialization", async () => {
      const { MainI18nService } = await import("./i18n-service");
      MainI18nService.resetInstance();
      const service = MainI18nService.getInstance();

      const result = service.t(["key1", "key2"] as unknown as string);
      expect(result).toBe("key1");
    });
  });

  describe("mainI18n export", () => {
    it("should export mainI18n singleton", async () => {
      const { mainI18n } = await import("./i18n-service");

      expect(mainI18n).toBeDefined();
      expect(typeof mainI18n.initialize).toBe("function");
      expect(typeof mainI18n.t).toBe("function");
      expect(typeof mainI18n.changeLanguage).toBe("function");
      expect(typeof mainI18n.getCurrentLanguage).toBe("function");
      expect(typeof mainI18n.detectSystemLanguage).toBe("function");
    });
  });
});
