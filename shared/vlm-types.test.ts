import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { VLMResponseSchema, VLMResponse, SUPPORTED_IMAGE_TYPES, MAX_IMAGE_SIZE } from "./vlm-types";

/**
 *
 *
 * _For any_ object, if it conforms to the VLMResponse structure (has title, description,
 * objects array, optional text array, confidence 0-100), VLMResponseSchema.safeParse()
 * SHALL return success: true. For any object that does not conform, it SHALL return success: false.
 */
describe("VLMResponse Schema Validation", () => {
  // Arbitrary for valid VLMResponse
  const validVLMResponseArb: fc.Arbitrary<VLMResponse> = fc.record({
    title: fc.string(),
    description: fc.string(),
    objects: fc.array(fc.string()),
    text: fc.option(fc.array(fc.string()), { nil: undefined }),
    confidence: fc.integer({ min: 0, max: 100 }),
  });

  it("Property 2.1: Valid VLMResponse objects pass schema validation", () => {
    fc.assert(
      fc.property(validVLMResponseArb, (vlmResponse) => {
        const result = VLMResponseSchema.safeParse(vlmResponse);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.title).toBe(vlmResponse.title);
          expect(result.data.description).toBe(vlmResponse.description);
          expect(result.data.objects).toEqual(vlmResponse.objects);
          expect(result.data.confidence).toBe(vlmResponse.confidence);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 2.2: Objects missing required fields fail validation", () => {
    // Missing title
    fc.assert(
      fc.property(
        fc.record({
          description: fc.string(),
          objects: fc.array(fc.string()),
          confidence: fc.integer({ min: 0, max: 100 }),
        }),
        (partialObj) => {
          const result = VLMResponseSchema.safeParse(partialObj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    // Missing description
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string(),
          objects: fc.array(fc.string()),
          confidence: fc.integer({ min: 0, max: 100 }),
        }),
        (partialObj) => {
          const result = VLMResponseSchema.safeParse(partialObj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    // Missing objects
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string(),
          description: fc.string(),
          confidence: fc.integer({ min: 0, max: 100 }),
        }),
        (partialObj) => {
          const result = VLMResponseSchema.safeParse(partialObj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    // Missing confidence
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string(),
          description: fc.string(),
          objects: fc.array(fc.string()),
        }),
        (partialObj) => {
          const result = VLMResponseSchema.safeParse(partialObj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 2.3: Confidence outside 0-100 range fails validation", () => {
    // Confidence below 0
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string(),
          description: fc.string(),
          objects: fc.array(fc.string()),
          confidence: fc.integer({ max: -1 }),
        }),
        (obj) => {
          const result = VLMResponseSchema.safeParse(obj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    // Confidence above 100
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string(),
          description: fc.string(),
          objects: fc.array(fc.string()),
          confidence: fc.integer({ min: 101 }),
        }),
        (obj) => {
          const result = VLMResponseSchema.safeParse(obj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 2.4: Wrong types for fields fail validation", () => {
    // title as number
    fc.assert(
      fc.property(
        fc.record({
          title: fc.integer(),
          description: fc.string(),
          objects: fc.array(fc.string()),
          confidence: fc.integer({ min: 0, max: 100 }),
        }),
        (obj) => {
          const result = VLMResponseSchema.safeParse(obj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    // objects as string instead of array
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string(),
          description: fc.string(),
          objects: fc.string(),
          confidence: fc.integer({ min: 0, max: 100 }),
        }),
        (obj) => {
          const result = VLMResponseSchema.safeParse(obj);
          expect(result.success).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 2.5: VLMResponse with optional text field validates correctly", () => {
    // With text field
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string(),
          description: fc.string(),
          objects: fc.array(fc.string()),
          text: fc.array(fc.string()),
          confidence: fc.integer({ min: 0, max: 100 }),
        }),
        (obj) => {
          const result = VLMResponseSchema.safeParse(obj);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.text).toEqual(obj.text);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Additional tests for constants
  it("SUPPORTED_IMAGE_TYPES contains expected MIME types", () => {
    expect(SUPPORTED_IMAGE_TYPES).toContain("image/jpeg");
    expect(SUPPORTED_IMAGE_TYPES).toContain("image/png");
    expect(SUPPORTED_IMAGE_TYPES).toContain("image/webp");
    expect(SUPPORTED_IMAGE_TYPES).toContain("image/gif");
    expect(SUPPORTED_IMAGE_TYPES.length).toBe(4);
  });

  it("MAX_IMAGE_SIZE is 20MB", () => {
    expect(MAX_IMAGE_SIZE).toBe(20 * 1024 * 1024);
  });
});
