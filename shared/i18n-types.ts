/**
 * Supported languages in the application
 */
export type SupportedLanguage = "en" | "zh-CN";

/**
 * List of all supported languages
 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["en", "zh-CN"] as const;

/**
 * Default/fallback language
 */
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

/**
 * Storage key for persisting language preference
 */
export const LANGUAGE_STORAGE_KEY = "mnemora-language";

/**
 * Language display names for UI
 */
export const LANGUAGE_DISPLAY_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

/**
 * Check if a value is a supported language
 */
export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}
