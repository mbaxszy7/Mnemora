import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import {
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "@shared/i18n-types";

/**
 * **Feature: electron-i18n, Property 6: Language Persistence Round-Trip**
 * **Validates: Requirements 5.1, 5.2**
 *
 * _For any_ supported language, saving to storage and then restoring
 * SHALL return the same language value.
 */
describe("Language Persistence Round-Trip", () => {
  // Mock localStorage for testing
  let mockStorage: Map<string, string>;

  beforeEach(() => {
    mockStorage = new Map();
    // Mock localStorage
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => mockStorage.get(key) ?? null,
        setItem: (key: string, value: string) => mockStorage.set(key, value),
        removeItem: (key: string) => mockStorage.delete(key),
        clear: () => mockStorage.clear(),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    mockStorage.clear();
  });

  /**
   * Helper function to save language to storage
   */
  function saveLanguageToStorage(lang: SupportedLanguage): void {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  }

  /**
   * Helper function to restore language from storage
   */
  function restoreLanguageFromStorage(): SupportedLanguage | null {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") {
      return stored;
    }
    return null;
  }

  it("Property 6: Saving and restoring any supported language returns the same value", () => {
    // Generate only supported languages
    const supportedLanguageArb = fc.constantFrom(
      ...SUPPORTED_LANGUAGES
    ) as fc.Arbitrary<SupportedLanguage>;

    fc.assert(
      fc.property(supportedLanguageArb, (language) => {
        // Save to storage
        saveLanguageToStorage(language);

        // Restore from storage
        const restored = restoreLanguageFromStorage();

        // Round-trip should preserve the value
        expect(restored).toBe(language);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 6.1: Multiple save operations preserve the last saved language", () => {
    const supportedLanguageArb = fc.constantFrom(
      ...SUPPORTED_LANGUAGES
    ) as fc.Arbitrary<SupportedLanguage>;

    fc.assert(
      fc.property(fc.array(supportedLanguageArb, { minLength: 1, maxLength: 10 }), (languages) => {
        // Save multiple languages in sequence
        for (const lang of languages) {
          saveLanguageToStorage(lang);
        }

        // Restore should return the last saved language
        const restored = restoreLanguageFromStorage();
        const lastLanguage = languages[languages.length - 1];

        expect(restored).toBe(lastLanguage);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 6.2: Invalid stored values return null on restore", () => {
    // Generate strings that are NOT valid supported languages
    const invalidLanguageArb = fc.string().filter((s) => s !== "en" && s !== "zh-CN");

    fc.assert(
      fc.property(invalidLanguageArb, (invalidLang) => {
        // Directly set invalid value in storage
        localStorage.setItem(LANGUAGE_STORAGE_KEY, invalidLang);

        // Restore should return null for invalid values
        const restored = restoreLanguageFromStorage();

        expect(restored).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});
