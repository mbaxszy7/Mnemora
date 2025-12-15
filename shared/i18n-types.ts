export type SupportedLanguage = "en" | "zh-CN";

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["en", "zh-CN"] as const;

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

export const LANGUAGE_STORAGE_KEY = "mnemora-language";

export const LANGUAGE_DISPLAY_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}
