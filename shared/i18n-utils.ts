import {
  SupportedLanguage,
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  isSupportedLanguage,
} from "./i18n-types";

/**
 * Detect the appropriate language from a locale string.
 *
 * Rules:
 * - If locale starts with "zh", return "zh-CN"
 * - Otherwise, return "en" (default)
 *
 * @param locale - The system locale string (e.g., "en-US", "zh-CN", "zh-TW", "fr-FR")
 * @returns The detected supported language
 *
 * @example
 * detectLanguageFromLocale("zh-CN") // returns "zh-CN"
 * detectLanguageFromLocale("zh-TW") // returns "zh-CN"
 * detectLanguageFromLocale("zh")    // returns "zh-CN"
 * detectLanguageFromLocale("en-US") // returns "en"
 * detectLanguageFromLocale("fr-FR") // returns "en"
 * detectLanguageFromLocale("")      // returns "en"
 */
export function detectLanguageFromLocale(locale: string): SupportedLanguage {
  if (typeof locale === "string" && locale.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Save language preference to localStorage
 *
 * @param language - The language to save
 */
export function saveLanguagePreference(language: SupportedLanguage): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }
}

/**
 * Load language preference from localStorage
 *
 * @returns The saved language or null if not found/invalid
 */
export function loadLanguagePreference(): SupportedLanguage | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (saved && isSupportedLanguage(saved)) {
    return saved;
  }
  return null;
}
