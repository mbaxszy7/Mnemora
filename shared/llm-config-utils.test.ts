import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  isValidUrl,
  isEndpointConfigComplete,
  isSeparateConfigComplete,
  encodeApiKey,
  decodeApiKey,
  getValidationErrorKey,
} from "./llm-config-utils";
import { LLMEndpointConfig, LLMValidationErrorCode } from "./llm-config-types";

/**
 *
 *
 * For any LLMEndpointConfig object, the validation function SHALL return true
 * if and only if baseUrl is a non-empty valid URL, apiKey is a non-empty string,
 * and model is a non-empty string.
 */
describe("Property 1: Configuration completeness validation", () => {
  // Arbitrary for valid endpoint config
  const validEndpointConfigArb = fc.record({
    baseUrl: fc.oneof(
      fc.constant("https://api.openai.com"),
      fc.constant("http://localhost:8080"),
      fc.constant("https://example.com/v1")
    ),
    apiKey: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
    model: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  });

  // Arbitrary for invalid endpoint config (missing or invalid fields)
  const invalidEndpointConfigArb = fc.oneof(
    // Empty baseUrl
    fc.record({
      baseUrl: fc.constant(""),
      apiKey: fc.string({ minLength: 1 }),
      model: fc.string({ minLength: 1 }),
    }),
    // Invalid URL format
    fc.record({
      baseUrl: fc.string().filter((s) => !s.startsWith("http")),
      apiKey: fc.string({ minLength: 1 }),
      model: fc.string({ minLength: 1 }),
    }),
    // Empty apiKey
    fc.record({
      baseUrl: fc.constant("https://api.openai.com"),
      apiKey: fc.constant(""),
      model: fc.string({ minLength: 1 }),
    }),
    // Whitespace-only apiKey
    fc.record({
      baseUrl: fc.constant("https://api.openai.com"),
      apiKey: fc.constantFrom("   ", "  ", " \t "),
      model: fc.string({ minLength: 1 }),
    }),
    // Empty model
    fc.record({
      baseUrl: fc.constant("https://api.openai.com"),
      apiKey: fc.string({ minLength: 1 }),
      model: fc.constant(""),
    }),
    // Whitespace-only model
    fc.record({
      baseUrl: fc.constant("https://api.openai.com"),
      apiKey: fc.string({ minLength: 1 }),
      model: fc.constantFrom("   ", "  ", " \t "),
    })
  );

  it("returns true for valid complete configurations", () => {
    fc.assert(
      fc.property(validEndpointConfigArb, (config: LLMEndpointConfig) => {
        expect(isEndpointConfigComplete(config)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("returns false for invalid or incomplete configurations", () => {
    fc.assert(
      fc.property(invalidEndpointConfigArb, (config: LLMEndpointConfig) => {
        expect(isEndpointConfigComplete(config)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 *
 *
 * For any string input to the URL validation function, it SHALL return true
 * if and only if the string is a valid HTTP or HTTPS URL format.
 */
describe("Property 2: URL format validation", () => {
  // Arbitrary for valid HTTP/HTTPS URLs
  const validUrlArb = fc.oneof(
    fc.webUrl({ validSchemes: ["http", "https"] }),
    fc.constant("http://localhost:8080"),
    fc.constant("https://api.openai.com/v1"),
    fc.constant("http://127.0.0.1:3000")
  );

  // Arbitrary for invalid URLs
  const invalidUrlArb = fc.oneof(
    fc.constant(""),
    fc.constant("not-a-url"),
    fc.constant("ftp://example.com"),
    fc.constant("file:///path/to/file"),
    fc.constant("mailto:test@example.com"),
    fc.string().filter((s) => {
      try {
        const url = new URL(s);
        return url.protocol !== "http:" && url.protocol !== "https:";
      } catch {
        return true; // Invalid URL format
      }
    })
  );

  it("returns true for valid HTTP/HTTPS URLs", () => {
    fc.assert(
      fc.property(validUrlArb, (url: string) => {
        expect(isValidUrl(url)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("returns false for invalid or non-HTTP/HTTPS URLs", () => {
    fc.assert(
      fc.property(invalidUrlArb, (url: string) => {
        expect(isValidUrl(url)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 *
 *
 * For any validation error with a specific error code, the error key function
 * SHALL return a valid i18n key that correctly identifies the error type.
 */
describe("Property 5: Error message mapping", () => {
  const errorCodeValues = Object.values(LLMValidationErrorCode);

  it("returns valid i18n key for every error code", () => {
    fc.assert(
      fc.property(fc.constantFrom(...errorCodeValues), (errorCode: LLMValidationErrorCode) => {
        const key = getValidationErrorKey(errorCode);
        expect(typeof key).toBe("string");
        expect(key).toMatch(/^llmConfig\.validation\./);
        expect(key).toBe(`llmConfig.validation.${errorCode}`);
      }),
      { numRuns: 100 }
    );
  });

  it("returns UNKNOWN key for invalid error codes", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !errorCodeValues.includes(s as LLMValidationErrorCode)),
        (invalidCode: string) => {
          const key = getValidationErrorKey(invalidCode as LLMValidationErrorCode);
          expect(key).toBe(`llmConfig.validation.${LLMValidationErrorCode.UNKNOWN}`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("i18n key format is consistent for all error codes", () => {
    fc.assert(
      fc.property(fc.constantFrom(...errorCodeValues), (errorCode: LLMValidationErrorCode) => {
        const key = getValidationErrorKey(errorCode);
        // Key should follow the pattern: llmConfig.validation.<ERROR_CODE>
        const parts = key.split(".");
        expect(parts).toHaveLength(3);
        expect(parts[0]).toBe("llmConfig");
        expect(parts[1]).toBe("validation");
        expect(parts[2]).toBe(errorCode);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 *
 *
 * For any valid API key string, encoding then decoding SHALL produce the original string.
 */
describe("Property 6: API key encoding round-trip", () => {
  it("encoding then decoding returns the original string", () => {
    fc.assert(
      fc.property(fc.string(), (apiKey: string) => {
        const encoded = encodeApiKey(apiKey);
        const decoded = decodeApiKey(encoded);
        expect(decoded).toBe(apiKey);
      }),
      { numRuns: 100 }
    );
  });

  it("encoding produces a different string for non-empty input", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !/^[A-Za-z0-9+/=]*$/.test(s)),
        (apiKey: string) => {
          const encoded = encodeApiKey(apiKey);
          // Encoded should be different from original (unless original is already base64-like)
          expect(encoded).not.toBe(apiKey);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("handles empty string correctly", () => {
    expect(encodeApiKey("")).toBe("");
    expect(decodeApiKey("")).toBe("");
  });

  it("handles null/undefined gracefully", () => {
    expect(encodeApiKey(null as unknown as string)).toBe("");
    expect(encodeApiKey(undefined as unknown as string)).toBe("");
    expect(decodeApiKey(null as unknown as string)).toBe("");
    expect(decodeApiKey(undefined as unknown as string)).toBe("");
  });

  it("decodeApiKey returns empty for non-string input", () => {
    expect(decodeApiKey(123 as unknown as string)).toBe("");
  });
});

describe("isSeparateConfigComplete", () => {
  const validEndpoint = {
    baseUrl: "https://api.test.com",
    apiKey: "sk-test",
    model: "gpt-4",
  };

  it("returns true when all three endpoints are complete", () => {
    expect(
      isSeparateConfigComplete({
        mode: "separate",
        vlm: validEndpoint,
        textLlm: validEndpoint,
        embeddingLlm: validEndpoint,
      })
    ).toBe(true);
  });

  it("returns false when vlm endpoint is incomplete", () => {
    expect(
      isSeparateConfigComplete({
        mode: "separate",
        vlm: { ...validEndpoint, apiKey: "" },
        textLlm: validEndpoint,
        embeddingLlm: validEndpoint,
      })
    ).toBe(false);
  });

  it("returns false when textLlm endpoint is incomplete", () => {
    expect(
      isSeparateConfigComplete({
        mode: "separate",
        vlm: validEndpoint,
        textLlm: { ...validEndpoint, model: "  " },
        embeddingLlm: validEndpoint,
      })
    ).toBe(false);
  });

  it("returns false when embeddingLlm endpoint is incomplete", () => {
    expect(
      isSeparateConfigComplete({
        mode: "separate",
        vlm: validEndpoint,
        textLlm: validEndpoint,
        embeddingLlm: { ...validEndpoint, baseUrl: "not-a-url" },
      })
    ).toBe(false);
  });
});
