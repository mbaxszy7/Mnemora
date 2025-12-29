import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import enTranslations from "./locales/en.json";
import zhCNTranslations from "./locales/zh-CN.json";

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
 * Helper function to perform variable interpolation (mimics i18next behavior)
 * Uses a function replacement to avoid special $ patterns in String.replace()
 */
function interpolate(template: string, variables: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g");
    // Use function replacement to avoid special $ patterns like $`, $', $&
    result = result.replace(regex, () => String(value));
  }
  return result;
}

/**
 *
 *
 * _For any_ valid translation resource object, serializing to JSON and then
 * parsing back SHALL produce an equivalent object.
 */
describe("Translation Resource Round-Trip", () => {
  it("Property 3: English translations survive JSON round-trip", () => {
    const serialized = JSON.stringify(enTranslations);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(enTranslations);
  });

  it("Property 3: Chinese translations survive JSON round-trip", () => {
    const serialized = JSON.stringify(zhCNTranslations);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(zhCNTranslations);
  });

  it("Property 3: Arbitrary nested objects survive JSON round-trip", () => {
    // Generate arbitrary nested translation-like objects
    const translationValueArb = fc.string({ minLength: 1, maxLength: 100 });

    const nestedObjectArb: fc.Arbitrary<Record<string, unknown>> = fc.letrec((tie) => ({
      leaf: translationValueArb,
      node: fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s)),
        fc.oneof({ depthSize: "small" }, tie("leaf"), tie("node")),
        { minKeys: 1, maxKeys: 5 }
      ),
    })).node as fc.Arbitrary<Record<string, unknown>>;

    fc.assert(
      fc.property(nestedObjectArb, (resource) => {
        const serialized = JSON.stringify(resource);
        const parsed = JSON.parse(serialized);
        expect(parsed).toEqual(resource);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 *
 *
 * _For any_ nested translation key (e.g., "common.buttons.save"), the translation
 * function SHALL correctly traverse the nested structure and return the corresponding value.
 */
describe("Nested Key Resolution", () => {
  // Collect all valid keys from the English translations
  const allKeys = collectLeafKeys(enTranslations as Record<string, unknown>);

  it("Property 4: All nested keys in English translations resolve correctly", () => {
    fc.assert(
      fc.property(fc.constantFrom(...allKeys), (key) => {
        const value = getNestedValue(enTranslations as Record<string, unknown>, key);
        expect(value).toBeDefined();
        expect(typeof value).toBe("string");
      }),
      { numRuns: Math.min(100, allKeys.length * 2) }
    );
  });

  it("Property 4: All nested keys in Chinese translations resolve correctly", () => {
    fc.assert(
      fc.property(fc.constantFrom(...allKeys), (key) => {
        const value = getNestedValue(zhCNTranslations as Record<string, unknown>, key);
        expect(value).toBeDefined();
        expect(typeof value).toBe("string");
      }),
      { numRuns: Math.min(100, allKeys.length * 2) }
    );
  });

  it("Property 4: Nested key resolution works for arbitrary valid paths", () => {
    // Generate valid key paths and verify resolution
    const keySegmentArb = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));
    const keyPathArb = fc.array(keySegmentArb, { minLength: 1, maxLength: 4 });

    fc.assert(
      fc.property(keyPathArb, fc.string({ minLength: 1 }), (pathSegments, leafValue) => {
        // Build a nested object from the path
        const obj: Record<string, unknown> = {};
        let current = obj;

        for (let i = 0; i < pathSegments.length - 1; i++) {
          current[pathSegments[i]] = {};
          current = current[pathSegments[i]] as Record<string, unknown>;
        }
        current[pathSegments[pathSegments.length - 1]] = leafValue;

        // Verify resolution
        const keyPath = pathSegments.join(".");
        const resolved = getNestedValue(obj, keyPath);
        expect(resolved).toBe(leafValue);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 *
 *
 * _For any_ translation string containing interpolation placeholders ({{variable}}),
 * the translation function SHALL replace all placeholders with the provided values.
 */
describe("Variable Interpolation", () => {
  it("Property 5: Single variable interpolation works correctly", () => {
    const variableNameArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));
    const variableValueArb = fc.oneof(
      fc.string({ minLength: 0, maxLength: 50 }),
      fc.integer().map(String)
    );

    fc.assert(
      fc.property(variableNameArb, variableValueArb, (varName, varValue) => {
        const template = `Hello {{${varName}}}!`;
        const result = interpolate(template, { [varName]: varValue });
        expect(result).toBe(`Hello ${varValue}!`);
        expect(result).not.toContain("{{");
        expect(result).not.toContain("}}");
      }),
      { numRuns: 100 }
    );
  });

  it("Property 5: Multiple variable interpolation works correctly", () => {
    const variableNameArb = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));
    // Filter out values containing {{ or }} to avoid false positives
    const variableValueArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !s.includes("{{") && !s.includes("}}"));

    fc.assert(
      fc.property(
        fc.uniqueArray(variableNameArb, { minLength: 1, maxLength: 5 }),
        fc.array(variableValueArb, { minLength: 1, maxLength: 5 }),
        (varNames, varValues) => {
          // Ensure we have matching lengths
          const count = Math.min(varNames.length, varValues.length);
          const names = varNames.slice(0, count);
          const values = varValues.slice(0, count);

          // Build template with all variables
          const template = names.map((name) => `{{${name}}}`).join(" ");
          const variables: Record<string, string> = {};
          names.forEach((name, i) => {
            variables[name] = values[i];
          });

          const result = interpolate(template, variables);

          // Verify all placeholders are replaced
          expect(result).not.toContain("{{");
          expect(result).not.toContain("}}");

          // Verify all values are present
          values.forEach((value) => {
            expect(result).toContain(value);
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 5: Interpolation with spaces around variable names works", () => {
    const variableNameArb = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));
    const variableValueArb = fc.string({ minLength: 1, maxLength: 20 });

    fc.assert(
      fc.property(variableNameArb, variableValueArb, (varName, varValue) => {
        // Test with spaces around variable name (i18next supports this)
        const template = `Value: {{ ${varName} }}`;
        const result = interpolate(template, { [varName]: varValue });
        expect(result).toBe(`Value: ${varValue}`);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 5: Numeric values are correctly interpolated", () => {
    const variableNameArb = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

    fc.assert(
      fc.property(variableNameArb, fc.integer(), (varName, numValue) => {
        const template = `Count: {{${varName}}}`;
        const result = interpolate(template, { [varName]: numValue });
        expect(result).toBe(`Count: ${numValue}`);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 5: Template without placeholders remains unchanged", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes("{{") && !s.includes("}}")),
        (template) => {
          const result = interpolate(template, { anyVar: "anyValue" });
          expect(result).toBe(template);
        }
      ),
      { numRuns: 100 }
    );
  });
});
