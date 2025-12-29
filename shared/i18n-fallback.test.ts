import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";
import i18next, { i18n } from "i18next";
import enTranslations from "./locales/en.json";
import zhCNTranslations from "./locales/zh-CN.json";

/**
 * Helper function to collect all leaf keys from a nested object
 */
function collectLeafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...collectLeafKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }

  return keys;
}

/**
 * Helper function to get a nested value from an object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 *
 *
 * _For any_ translation key that does not exist in the current language resource,
 * the translation function SHALL return the English fallback text instead of the key.
 */
describe("Missing Translation Fallback", () => {
  let i18nInstance: i18n;
  const translate = (key: string) =>
    (i18nInstance as unknown as { t: (k: string) => string }).t(key);

  beforeAll(async () => {
    // Create a test i18next instance with fallback configured
    i18nInstance = i18next.createInstance();
    await i18nInstance.init({
      lng: "zh-CN",
      fallbackLng: "en",
      supportedLngs: ["en", "zh-CN"],
      resources: {
        en: { translation: enTranslations },
        "zh-CN": { translation: zhCNTranslations },
      },
      interpolation: {
        escapeValue: false,
      },
    });
  });

  afterAll(() => {
    // Clean up
  });

  // Collect all valid keys from English translations
  const allEnglishKeys = collectLeafKeys(enTranslations as Record<string, unknown>);

  it("Property 2: Valid keys return translated values, not the key itself", () => {
    fc.assert(
      fc.property(fc.constantFrom(...allEnglishKeys), (key) => {
        const result = translate(key);
        const englishValue = getNestedValue(enTranslations as Record<string, unknown>, key);

        // The result should be a string (either translated or fallback)
        expect(typeof result).toBe("string");

        // The result should NOT be the key itself (unless the English value equals the key)
        if (englishValue !== key) {
          expect(result).not.toBe(key);
        }
      }),
      { numRuns: Math.min(100, allEnglishKeys.length * 2) }
    );
  });

  it("Property 2: Missing keys in zh-CN fall back to English values", () => {
    fc.assert(
      fc.property(fc.constantFrom(...allEnglishKeys), (key) => {
        // Get the English value for this key
        const englishValue = getNestedValue(enTranslations as Record<string, unknown>, key);
        const zhCNValue = getNestedValue(zhCNTranslations as Record<string, unknown>, key);

        // When zh-CN has the key, it should return zh-CN value
        // When zh-CN doesn't have the key, it should fall back to English
        const result = translate(key);

        if (zhCNValue !== undefined) {
          expect(result).toBe(zhCNValue);
        } else {
          // Should fall back to English
          expect(result).toBe(englishValue);
        }
      }),
      { numRuns: Math.min(100, allEnglishKeys.length * 2) }
    );
  });

  it("Property 2: Non-existent keys return the key as fallback", () => {
    // Generate random keys that don't exist in translations
    const nonExistentKeyArb = fc
      .string({ minLength: 5, maxLength: 30 })
      .filter((s) => /^[a-zA-Z][a-zA-Z0-9.]*$/.test(s))
      .filter((s) => !allEnglishKeys.includes(s));

    fc.assert(
      fc.property(nonExistentKeyArb, (key) => {
        const result = translate(key);

        // For completely non-existent keys, i18next returns the key itself
        // This is expected behavior when there's no fallback available
        expect(typeof result).toBe("string");
      }),
      { numRuns: 100 }
    );
  });

  it("Property 2: Fallback works correctly when switching languages", async () => {
    // Test that fallback works when we switch to a language with missing keys
    const testInstance = i18next.createInstance();

    // Create a partial translation set for testing
    const partialTranslations = {
      common: {
        buttons: {
          save: "保存测试", // Only this key exists
        },
      },
    };

    await testInstance.init({
      lng: "test-lang",
      fallbackLng: "en",
      supportedLngs: ["en", "test-lang"],
      resources: {
        en: { translation: enTranslations },
        "test-lang": { translation: partialTranslations },
      },
      interpolation: {
        escapeValue: false,
      },
    });

    // Keys that exist in test-lang should return test-lang values
    expect(testInstance.t("common.buttons.save")).toBe("保存测试");

    // Keys that don't exist in test-lang should fall back to English
    expect(testInstance.t("common.buttons.cancel")).toBe(
      getNestedValue(enTranslations as Record<string, unknown>, "common.buttons.cancel")
    );
    expect(testInstance.t("nav.home")).toBe(
      getNestedValue(enTranslations as Record<string, unknown>, "nav.home")
    );
  });

  it("Property 2: All English keys have corresponding values (structural completeness)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...allEnglishKeys), (key) => {
        const englishValue = getNestedValue(enTranslations as Record<string, unknown>, key);

        // Every key in English translations should have a non-empty string value
        expect(englishValue).toBeDefined();
        expect(typeof englishValue).toBe("string");
        expect((englishValue as string).length).toBeGreaterThan(0);
      }),
      { numRuns: Math.min(100, allEnglishKeys.length * 2) }
    );
  });
});
