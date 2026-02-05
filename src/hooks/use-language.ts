import { useState, useCallback, useEffect, useRef, useTransition } from "react";
import { useTranslation } from "react-i18next";
import {
  type SupportedLanguage,
  LANGUAGE_STORAGE_KEY,
  LANGUAGE_DISPLAY_NAMES,
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
} from "@shared/i18n-types";

export interface UseLanguageReturn {
  /** Current active language */
  currentLanguage: SupportedLanguage;
  /** Change the application language */
  changeLanguage: (lang: SupportedLanguage) => Promise<void>;
  /** Whether a language change is in progress */
  isLoading: boolean;
  /** List of supported languages */
  supportedLanguages: readonly SupportedLanguage[];
  /** Display names for languages */
  languageDisplayNames: Record<SupportedLanguage, string>;
}

/**
 * Hook for managing application language
 * Handles persistence to localStorage and sync with main process via IPC
 */
export function useLanguage(): UseLanguageReturn {
  const { i18n } = useTranslation();
  const [, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(false);
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;

  // Get current language from i18n instance
  const currentLanguage = (
    isSupportedLanguage(i18n.language) ? i18n.language : "en"
  ) as SupportedLanguage;

  /**
   * Change language and persist to storage
   * Also notifies main process via IPC
   */
  const changeLanguage = useCallback(
    async (lang: SupportedLanguage) => {
      if (lang === currentLanguage) return;

      startTransition(async () => {
        setIsLoading(true);
        try {
          // Change i18next language
          await i18n.changeLanguage(lang);
          localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
          await window.i18nApi.changeLanguage(lang);
        } finally {
          setIsLoading(false);
        }
      });
    },
    [i18n, currentLanguage]
  );

  // Sync with main process on mount if available
  useEffect(() => {
    const syncWithMainProcess = async () => {
      if (window.i18nApi?.getLanguage) {
        try {
          const currentI18n = i18nRef.current;

          // Prefer renderer's persisted preference, and push it to main
          const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
          const storedLang = isSupportedLanguage(stored) ? stored : null;

          if (storedLang && storedLang !== currentI18n.language) {
            await currentI18n.changeLanguage(storedLang);
          }

          if (storedLang) {
            await window.i18nApi.changeLanguage(storedLang);
            return;
          }

          // No local preference -> pull from main
          const mainLanguage = await window.i18nApi.getLanguage();
          if (mainLanguage && mainLanguage !== currentI18n.language) {
            await currentI18n.changeLanguage(mainLanguage);
          }
        } catch {
          // Main process not available, use local state
        }
      }
    };

    syncWithMainProcess();
  }, []); // Only run on mount

  return {
    currentLanguage,
    changeLanguage,
    isLoading,
    supportedLanguages: SUPPORTED_LANGUAGES,
    languageDisplayNames: LANGUAGE_DISPLAY_NAMES,
  };
}

export default useLanguage;
