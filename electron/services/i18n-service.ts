import i18next, { i18n } from "i18next";
import Backend from "i18next-fs-backend";
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupportedLanguage, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from "@shared/i18n-types";
import { detectLanguageFromLocale } from "@shared/i18n-utils";
import { getLogger } from "./logger";
import { llmConfigService } from "./llm-config-service";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class MainI18nService {
  private static instance: MainI18nService | null = null;
  private i18nInstance: i18n | null = null;
  private initialized: boolean = false;
  private pendingLanguage: SupportedLanguage | null = null;
  private logger = getLogger("i18n-service");

  private constructor() {}

  static getInstance(): MainI18nService {
    if (!MainI18nService.instance) {
      MainI18nService.instance = new MainI18nService();
    }
    return MainI18nService.instance;
  }

  static resetInstance(): void {
    MainI18nService.instance = null;
  }

  private getLocalesPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "shared", "locales");
    }
    // Development mode - use APP_ROOT set by main.ts
    const appRoot = process.env.APP_ROOT || path.join(__dirname, "..");
    return path.join(appRoot, "shared", "locales");
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn("i18n service already initialized");
      return;
    }

    this.i18nInstance = i18next.createInstance();
    const localesPath = this.getLocalesPath();

    // Priority: 1. Saved preference from DB, 2. System language
    const config = await llmConfigService.loadConfiguration();
    const savedLanguage = config?.language;
    const initialLanguage = savedLanguage ?? this.detectSystemLanguage();

    this.logger.info({ localesPath, initialLanguage, savedLanguage }, "Initializing i18n service");

    await this.i18nInstance.use(Backend).init({
      lng: initialLanguage,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: [...SUPPORTED_LANGUAGES],
      preload: [...SUPPORTED_LANGUAGES], // Preload all languages
      backend: {
        loadPath: path.join(localesPath, "{{lng}}.json"),
      },
      interpolation: {
        escapeValue: false,
      },
    });

    this.initialized = true;

    if (this.pendingLanguage && this.pendingLanguage !== this.getCurrentLanguage()) {
      const lang = this.pendingLanguage;
      this.pendingLanguage = null;
      await this.changeLanguage(lang);
    }
    this.logger.info({ language: this.getCurrentLanguage() }, "i18n service initialized");
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  t(...args: Parameters<i18n["t"]>): string {
    if (!this.initialized || !this.i18nInstance) {
      const key = args[0];
      this.logger.warn({ key }, "Translation requested before initialization");
      return String(Array.isArray(key) ? key[0] : key);
    }
    return this.i18nInstance.t(...args);
  }

  async changeLanguage(lang: SupportedLanguage): Promise<void> {
    if (!this.initialized || !this.i18nInstance) {
      this.pendingLanguage = lang;
      this.logger.warn({ lang }, "Language change requested before initialization");
      return;
    }

    this.logger.info({ lang }, "Changing language in main process");
    await this.i18nInstance.changeLanguage(lang);

    // Update language in DB
    try {
      const config = await llmConfigService.loadConfiguration();
      this.logger.info({ hasConfig: !!config }, "Loaded configuration for language update");

      if (config) {
        config.language = lang;
        await llmConfigService.saveConfiguration(config);
        this.logger.info({ language: lang }, "Language changed and saved to DB");
      } else {
        this.logger.warn("Could not save language: LLM configuration not found");
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to save language preference to DB");
    }
  }

  getCurrentLanguage(): SupportedLanguage {
    if (this.pendingLanguage) {
      return this.pendingLanguage;
    }
    if (!this.initialized || !this.i18nInstance) {
      return DEFAULT_LANGUAGE;
    }
    this.logger.info({ language: this.i18nInstance.language }, "Current language");
    return this.i18nInstance.language as SupportedLanguage;
  }

  detectSystemLanguage(): SupportedLanguage {
    const systemLocale = app.getLocale();
    return detectLanguageFromLocale(systemLocale);
  }
}

export const mainI18n = MainI18nService.getInstance();

export { MainI18nService };
