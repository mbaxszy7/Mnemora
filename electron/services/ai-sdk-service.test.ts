import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import { AISDKService, type AISDKConfig } from "./ai-sdk-service";
import { ServiceError, ErrorCode } from "@shared/errors";

/**
 * **Feature: ai-sdk-refactor, Property 1: Singleton Invariant (AISDKService)**
 * **Validates: Requirements 2.1**
 *
 * _For any_ singleton service class (AISDKService), multiple calls to getInstance()
 * SHALL return the exact same object reference.
 */
describe("AISDKService Singleton Invariant", () => {
  beforeEach(() => {
    // Reset the singleton before each test to ensure isolation
    AISDKService.resetInstance();
  });

  it("Property 1: Multiple getInstance() calls return the same instance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        (numCalls) => {
          // Reset before this property run
          AISDKService.resetInstance();

          // Get the first instance
          const firstInstance = AISDKService.getInstance();

          // Call getInstance() multiple times and verify all return the same reference
          for (let i = 0; i < numCalls; i++) {
            const instance = AISDKService.getInstance();
            expect(instance).toBe(firstInstance);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 1.1: getInstance() always returns a valid AISDKService instance", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        AISDKService.resetInstance();
        const instance = AISDKService.getInstance();
        expect(instance).toBeInstanceOf(AISDKService);
        expect(typeof instance.isInitialized).toBe("function");
        expect(typeof instance.initialize).toBe("function");
        expect(typeof instance.getClient).toBe("function");
      }),
      { numRuns: 100 }
    );
  });

  it("Property 1.2: resetInstance() creates a new instance on next getInstance()", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const firstInstance = AISDKService.getInstance();
        AISDKService.resetInstance();
        const secondInstance = AISDKService.getInstance();
        
        // After reset, we should get a different instance
        expect(secondInstance).not.toBe(firstInstance);
      }),
      { numRuns: 100 }
    );
  });
});


/**
 * **Feature: ai-sdk-refactor, Property 5: Service Initialization Behavior**
 * **Validates: Requirements 2.2, 2.3, 3.4**
 *
 * _For any_ AISDKConfig with empty or missing apiKey, initialize() SHALL throw
 * ServiceError with API_KEY_MISSING code.
 * _For any_ call to getClient() before initialization, it SHALL throw ServiceError
 * with NOT_INITIALIZED code.
 */
describe("AISDKService Initialization Behavior", () => {
  beforeEach(() => {
    AISDKService.resetInstance();
  });

  // Generator for empty/whitespace-only API keys
  const emptyApiKeyArb = fc.oneof(
    fc.constant(""),
    fc.constant("   "),
    fc.constant("\t"),
    fc.constant("\n"),
    fc.constant("  \t  \n  ")
  );

  // Generator for valid config base (without apiKey)
  const configBaseArb = fc.record({
    name: fc.string({ minLength: 1 }),
    baseURL: fc.webUrl(),
    model: fc.string({ minLength: 1 }),
  });

  it("Property 5.1: initialize() throws API_KEY_MISSING for empty apiKey", () => {
    fc.assert(
      fc.property(emptyApiKeyArb, configBaseArb, (apiKey, configBase) => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        const config: AISDKConfig = {
          ...configBase,
          apiKey,
        };

        expect(() => service.initialize(config)).toThrow(ServiceError);

        try {
          service.initialize(config);
        } catch (error) {
          expect(error).toBeInstanceOf(ServiceError);
          expect((error as ServiceError).code).toBe(ErrorCode.API_KEY_MISSING);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 5.2: getClient() throws NOT_INITIALIZED before initialization", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        // Service should not be initialized
        expect(service.isInitialized()).toBe(false);

        // getClient() should throw NOT_INITIALIZED
        expect(() => service.getClient()).toThrow(ServiceError);

        try {
          service.getClient();
        } catch (error) {
          expect(error).toBeInstanceOf(ServiceError);
          expect((error as ServiceError).code).toBe(ErrorCode.NOT_INITIALIZED);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 5.3: isInitialized() returns false before initialization", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();
        expect(service.isInitialized()).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 5.4: Failed initialization leaves service in uninitialized state", () => {
    fc.assert(
      fc.property(emptyApiKeyArb, configBaseArb, (apiKey, configBase) => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        const config: AISDKConfig = {
          ...configBase,
          apiKey,
        };

        // Attempt to initialize with invalid config
        try {
          service.initialize(config);
        } catch {
          // Expected to throw
        }

        // Service should remain uninitialized
        expect(service.isInitialized()).toBe(false);

        // getClient() should still throw NOT_INITIALIZED
        expect(() => service.getClient()).toThrow(ServiceError);
      }),
      { numRuns: 100 }
    );
  });
});
