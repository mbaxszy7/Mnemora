/**
 * i18n Configuration for Renderer Process
 */
import type { SupportedLanguage } from "@shared/i18n-types";
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from "@shared/i18n-types";

/**
 * i18n configuration interface
 */
export interface I18nConfig {
  defaultLanguage: SupportedLanguage;
  fallbackLanguage: SupportedLanguage;
  supportedLanguages: readonly SupportedLanguage[];
  interpolation: {
    escapeValue: boolean;
  };
}

/**
 * Default i18n configuration
 */
export const i18nConfig: I18nConfig = {
  defaultLanguage: DEFAULT_LANGUAGE,
  fallbackLanguage: "en",
  supportedLanguages: SUPPORTED_LANGUAGES,
  interpolation: {
    escapeValue: false, // React already escapes values
  },
};

export default i18nConfig;
