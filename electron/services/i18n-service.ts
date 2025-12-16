import i18next, { i18n } from "i18next";
import Backend from "i18next-fs-backend";
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupportedLanguage, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from "@shared/i18n-types";
import { detectLanguageFromLocale } from "@shared/i18n-utils";
import { getLogger } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class MainI18nService {
  private static instance: MainI18nService | null = null;
  private i18nInstance: i18n | null = null;
  private initialized: boolean = false;
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
    const initialLanguage = this.detectSystemLanguage();

    this.logger.info({ localesPath, initialLanguage }, "Initializing i18n service");

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
      this.logger.warn({ lang }, "Language change requested before initialization");
      return;
    }

    await this.i18nInstance.changeLanguage(lang);
    this.logger.info({ language: lang }, "Language changed");
  }

  getCurrentLanguage(): SupportedLanguage {
    if (!this.initialized || !this.i18nInstance) {
      return DEFAULT_LANGUAGE;
    }
    return this.i18nInstance.language as SupportedLanguage;
  }

  detectSystemLanguage(): SupportedLanguage {
    const systemLocale = app.getLocale();
    return detectLanguageFromLocale(systemLocale);
  }
}

export const mainI18n = MainI18nService.getInstance();

export { MainI18nService };
