/**
 * i18next initialization for Renderer Process
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { i18nConfig } from "./config";
import { LANGUAGE_STORAGE_KEY, type SupportedLanguage } from "@shared/i18n-types";

// Import translation resources directly
import enTranslations from "@shared/locales/en.json";
import zhCNTranslations from "@shared/locales/zh-CN.json";

/**
 * Translation resources bundled for renderer process
 */
const resources = {
  en: { translation: enTranslations },
  "zh-CN": { translation: zhCNTranslations },
};

/**
 * Get initial language from localStorage or default
 */
function getInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && (stored === "en" || stored === "zh-CN")) {
      return stored;
    }
  } catch {
    // localStorage not available
  }
  return i18nConfig.defaultLanguage;
}

/**
 * Initialize i18next instance
 */
i18n.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: i18nConfig.fallbackLanguage,
  supportedLngs: [...i18nConfig.supportedLanguages],
  interpolation: i18nConfig.interpolation,
  react: {
    useSuspense: true,
  },
});

export default i18n;
