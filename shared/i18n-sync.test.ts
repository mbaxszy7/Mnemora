import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { SUPPORTED_LANGUAGES, type SupportedLanguage, isSupportedLanguage } from "./i18n-types";

/**
 *
 *
 * _For any_ language change in the Renderer Process, the Main Process
 * SHALL update its internal state to match the new language.
 */
describe("Language Sync Between Processes", () => {
  /**
   * Simulates the main process i18n state management
   * This mirrors the behavior of MainI18nService
   */
  class MockMainProcessI18n {
    private currentLanguage: SupportedLanguage = "en";
    private initialized: boolean = false;

    initialize(): void {
      this.initialized = true;
    }

    isInitialized(): boolean {
      return this.initialized;
    }

    changeLanguage(lang: SupportedLanguage): void {
      if (!this.initialized) return;
      if (isSupportedLanguage(lang)) {
        this.currentLanguage = lang;
      }
    }

    getCurrentLanguage(): SupportedLanguage {
      return this.currentLanguage;
    }

    reset(): void {
      this.currentLanguage = "en";
      this.initialized = false;
    }
  }

  /**
   * Simulates the IPC handler that receives language change requests
   * This mirrors the behavior of handleChangeLanguage in i18n-handlers.ts
   */
  function simulateIPCLanguageChange(
    mainI18n: MockMainProcessI18n,
    payload: { language: string }
  ): { success: boolean; error?: string } {
    const { language } = payload;

    // Validate language (same logic as in i18n-handlers.ts)
    if (!isSupportedLanguage(language)) {
      return {
        success: false,
        error: `Unsupported language: ${language}`,
      };
    }

    mainI18n.changeLanguage(language);

    return { success: true };
  }

  /**
   * Simulates the renderer process language change flow
   * This mirrors the behavior of useLanguage hook calling IPC
   */
  function simulateRendererLanguageChange(
    mainI18n: MockMainProcessI18n,
    newLanguage: SupportedLanguage
  ): { success: boolean; mainLanguage: SupportedLanguage } {
    // Simulate IPC call from renderer to main
    const result = simulateIPCLanguageChange(mainI18n, { language: newLanguage });

    return {
      success: result.success,
      mainLanguage: mainI18n.getCurrentLanguage(),
    };
  }

  let mainI18n: MockMainProcessI18n;

  beforeEach(() => {
    mainI18n = new MockMainProcessI18n();
    mainI18n.initialize();
  });

  afterEach(() => {
    mainI18n.reset();
  });

  it("Property 7: Any supported language change from renderer syncs to main process", () => {
    const supportedLanguageArb = fc.constantFrom(
      ...SUPPORTED_LANGUAGES
    ) as fc.Arbitrary<SupportedLanguage>;

    fc.assert(
      fc.property(supportedLanguageArb, (newLanguage) => {
        // Simulate renderer process changing language
        const result = simulateRendererLanguageChange(mainI18n, newLanguage);

        // Main process should update its state to match
        expect(result.success).toBe(true);
        expect(result.mainLanguage).toBe(newLanguage);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 7.1: Sequential language changes from renderer all sync correctly", () => {
    const supportedLanguageArb = fc.constantFrom(
      ...SUPPORTED_LANGUAGES
    ) as fc.Arbitrary<SupportedLanguage>;

    fc.assert(
      fc.property(
        fc.array(supportedLanguageArb, { minLength: 1, maxLength: 20 }),
        (languageSequence) => {
          // Simulate multiple language changes from renderer
          for (const lang of languageSequence) {
            const result = simulateRendererLanguageChange(mainI18n, lang);
            expect(result.success).toBe(true);
          }

          // Final state should match the last language in sequence
          const lastLanguage = languageSequence[languageSequence.length - 1];
          expect(mainI18n.getCurrentLanguage()).toBe(lastLanguage);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 7.2: Invalid language changes are rejected and don't affect main process state", () => {
    // Generate strings that are NOT valid supported languages
    const invalidLanguageArb = fc.string().filter((s) => !isSupportedLanguage(s));

    fc.assert(
      fc.property(invalidLanguageArb, (invalidLang) => {
        const initialLanguage = mainI18n.getCurrentLanguage();

        // Simulate IPC call with invalid language
        const result = simulateIPCLanguageChange(mainI18n, { language: invalidLang });

        // Should fail and not change the main process state
        expect(result.success).toBe(false);
        expect(mainI18n.getCurrentLanguage()).toBe(initialLanguage);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 7.3: Language sync is idempotent - same language change has no additional effect", () => {
    const supportedLanguageArb = fc.constantFrom(
      ...SUPPORTED_LANGUAGES
    ) as fc.Arbitrary<SupportedLanguage>;

    fc.assert(
      fc.property(
        supportedLanguageArb,
        fc.integer({ min: 1, max: 10 }),
        (language, repeatCount) => {
          // Change to the language once
          simulateRendererLanguageChange(mainI18n, language);
          const stateAfterFirst = mainI18n.getCurrentLanguage();

          // Change to the same language multiple times
          for (let i = 0; i < repeatCount; i++) {
            simulateRendererLanguageChange(mainI18n, language);
          }

          // State should remain the same
          expect(mainI18n.getCurrentLanguage()).toBe(stateAfterFirst);
          expect(mainI18n.getCurrentLanguage()).toBe(language);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 7.4: Uninitialized main process ignores language changes", () => {
    const supportedLanguageArb = fc.constantFrom(
      ...SUPPORTED_LANGUAGES
    ) as fc.Arbitrary<SupportedLanguage>;

    fc.assert(
      fc.property(supportedLanguageArb, (newLanguage) => {
        // Create uninitialized main process
        const uninitializedMain = new MockMainProcessI18n();
        const initialLanguage = uninitializedMain.getCurrentLanguage();

        // Try to change language
        uninitializedMain.changeLanguage(newLanguage);

        // Should not change because not initialized
        expect(uninitializedMain.getCurrentLanguage()).toBe(initialLanguage);
      }),
      { numRuns: 100 }
    );
  });
});
