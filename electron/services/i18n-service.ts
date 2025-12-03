import i18next, { i18n } from "i18next";
import Backend from "i18next-fs-backend";
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupportedLanguage, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from "@shared/i18n-types";
import { detectLanguageFromLocale } from "@shared/i18n-utils";
import { getLogger } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Main Process i18n Service
 * Uses i18next + i18next-fs-backend for translation management
 * Implements singleton pattern for centralized language management
 */
class MainI18nService {
  private static instance: MainI18nService | null = null;
  private i18nInstance: i18n | null = null;
  private initialized: boolean = false;
  private logger = getLogger("i18n-service");

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): MainI18nService {
    if (!MainI18nService.instance) {
      MainI18nService.instance = new MainI18nService();
    }
    return MainI18nService.instance;
  }

  /**
   * Reset instance (for testing only)
   */
  static resetInstance(): void {
    MainI18nService.instance = null;
  }

  /**
   * Get the locales directory path
   * In development: project_root/shared/locales
   * In production: resources/shared/locales
   */
  private getLocalesPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "shared", "locales");
    }
    // Development mode - go up from electron/services to project root
    const projectRoot = path.join(__dirname, "..", "..");
    return path.join(projectRoot, "shared", "locales");
  }

  /**
   * Initialize the i18n service
   * Loads all translation resources before any UI is displayed
   */
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

  /**
   * Check if the service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get translation text (synchronous method, available after initialization)
   * Proxies to i18next.t with strict type checking
   */
  t(...args: Parameters<i18n["t"]>): string {
    if (!this.initialized || !this.i18nInstance) {
      const key = args[0];
      this.logger.warn({ key }, "Translation requested before initialization");
      return String(Array.isArray(key) ? key[0] : key);
    }
    return this.i18nInstance.t(...args);
  }

  /**
   * Change the current language
   * @param lang - Target language
   */
  async changeLanguage(lang: SupportedLanguage): Promise<void> {
    if (!this.initialized || !this.i18nInstance) {
      this.logger.warn({ lang }, "Language change requested before initialization");
      return;
    }

    await this.i18nInstance.changeLanguage(lang);
    this.logger.info({ language: lang }, "Language changed");
  }

  /**
   * Get the current language
   * @returns Current language or default if not initialized
   */
  getCurrentLanguage(): SupportedLanguage {
    if (!this.initialized || !this.i18nInstance) {
      return DEFAULT_LANGUAGE;
    }
    return this.i18nInstance.language as SupportedLanguage;
  }

  /**
   * Detect system language using Electron's app.getLocale()
   * @returns Detected language (zh-CN for Chinese locales, en for others)
   */
  detectSystemLanguage(): SupportedLanguage {
    const systemLocale = app.getLocale();
    return detectLanguageFromLocale(systemLocale);
  }
}

/**
 * Export singleton instance getter
 */
export const mainI18n = MainI18nService.getInstance();

/**
 * Export class for testing purposes
 */
export { MainI18nService };
