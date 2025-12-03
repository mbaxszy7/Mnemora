import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import { VLMService } from "./vlm-service";
import { AISDKService } from "./ai-sdk-service";

/**
 * **Feature: ai-sdk-refactor, Property 1: Singleton Invariant (VLMService)**
 * **Validates: Requirements 3.1**
 *
 * _For any_ singleton service class (VLMService), multiple calls to getInstance()
 * SHALL return the exact same object reference.
 */
describe("VLMService Singleton Invariant", () => {
  beforeEach(() => {
    // Reset both singletons before each test to ensure isolation
    VLMService.resetInstance();
    AISDKService.resetInstance();
  });

  it("Property 1: Multiple getInstance() calls return the same instance", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), (numCalls) => {
        // Reset before this property run
        VLMService.resetInstance();
        AISDKService.resetInstance();

        // Get the first instance
        const firstInstance = VLMService.getInstance();

        // Call getInstance() multiple times and verify all return the same reference
        for (let i = 0; i < numCalls; i++) {
          const instance = VLMService.getInstance();
          expect(instance).toBe(firstInstance);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 1.1: getInstance() always returns a valid VLMService instance", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        VLMService.resetInstance();
        AISDKService.resetInstance();

        const instance = VLMService.getInstance();
        expect(instance).toBeInstanceOf(VLMService);
        expect(typeof instance.analyzeImage).toBe("function");
        expect(typeof instance.analyzeImageFromBase64).toBe("function");
      }),
      { numRuns: 100 }
    );
  });

  it("Property 1.2: resetInstance() creates a new instance on next getInstance()", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        VLMService.resetInstance();
        AISDKService.resetInstance();

        const firstInstance = VLMService.getInstance();
        VLMService.resetInstance();
        const secondInstance = VLMService.getInstance();

        // After reset, we should get a different instance
        expect(secondInstance).not.toBe(firstInstance);
      }),
      { numRuns: 100 }
    );
  });
});
