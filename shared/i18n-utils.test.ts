import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import {
  detectLanguageFromLocale,
  saveLanguagePreference,
  loadLanguagePreference,
} from "./i18n-utils";

/**
 *
 *
 * _For any_ system locale string, the locale detection function SHALL return
 * 'zh-CN' if the locale starts with 'zh', otherwise return 'en'.
 */
describe("Locale Detection Correctness", () => {
  it("Property 1: Returns 'zh-CN' for any locale starting with 'zh', otherwise returns 'en'", () => {
    fc.assert(
      fc.property(fc.string(), (locale) => {
        const result = detectLanguageFromLocale(locale);

        // Property: if locale starts with "zh" (case-insensitive), return "zh-CN"
        // Otherwise, return "en"
        if (locale.toLowerCase().startsWith("zh")) {
          expect(result).toBe("zh-CN");
        } else {
          expect(result).toBe("en");
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 1.1: Returns 'zh-CN' for Chinese locale variants", () => {
    fc.assert(
      fc.property(
        // Generate strings that start with "zh" followed by arbitrary suffix
        fc.string().map((suffix) => "zh" + suffix),
        (chineseLocale) => {
          const result = detectLanguageFromLocale(chineseLocale);
          expect(result).toBe("zh-CN");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 1.2: Returns 'en' for non-Chinese locales", () => {
    fc.assert(
      fc.property(
        // Generate strings that don't start with "zh" (case-insensitive)
        fc.string().filter((s) => !s.toLowerCase().startsWith("zh")),
        (nonChineseLocale) => {
          const result = detectLanguageFromLocale(nonChineseLocale);
          expect(result).toBe("en");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 1.3: Case-insensitive detection for Chinese locales", () => {
    fc.assert(
      fc.property(
        // Generate "zh" with random casing followed by arbitrary suffix
        fc
          .tuple(fc.constantFrom("zh", "Zh", "zH", "ZH"), fc.string())
          .map(([prefix, suffix]) => prefix + suffix),
        (mixedCaseLocale) => {
          const result = detectLanguageFromLocale(mixedCaseLocale);
          expect(result).toBe("zh-CN");
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("saveLanguagePreference", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it("saves language to localStorage", () => {
    saveLanguagePreference("en");
    expect(localStorage.setItem).toHaveBeenCalledWith("mnemora-language", "en");
  });

  it("saves zh-CN to localStorage", () => {
    saveLanguagePreference("zh-CN");
    expect(localStorage.setItem).toHaveBeenCalledWith("mnemora-language", "zh-CN");
  });
});

describe("loadLanguagePreference", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it("returns saved language when valid", () => {
    vi.mocked(localStorage.getItem).mockReturnValue("zh-CN");
    expect(loadLanguagePreference()).toBe("zh-CN");
  });

  it("returns null for invalid saved language", () => {
    vi.mocked(localStorage.getItem).mockReturnValue("fr-FR");
    expect(loadLanguagePreference()).toBeNull();
  });

  it("returns null when nothing saved", () => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    expect(loadLanguagePreference()).toBeNull();
  });
});
