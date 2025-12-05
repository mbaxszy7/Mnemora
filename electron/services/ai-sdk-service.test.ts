import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import { AISDKService } from "./ai-sdk-service";
import { ServiceError, ErrorCode } from "../../shared/errors";
import type { SeparateLLMConfig, UnifiedLLMConfig } from "../../shared/llm-config-types";

describe("AISDKService Singleton Invariant", () => {
  beforeEach(() => {
    AISDKService.resetInstance();
  });

  it("Property 1: Multiple getInstance() calls return the same instance", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), (numCalls) => {
        AISDKService.resetInstance();
        const firstInstance = AISDKService.getInstance();

        for (let i = 0; i < numCalls; i++) {
          const instance = AISDKService.getInstance();
          expect(instance).toBe(firstInstance);
        }
      }),
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
        expect(typeof instance.getVLMClient).toBe("function");
        expect(typeof instance.getTextClient).toBe("function");
        expect(typeof instance.getEmbeddingClient).toBe("function");
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
        expect(secondInstance).not.toBe(firstInstance);
      }),
      { numRuns: 100 }
    );
  });
});

describe("AISDKService Initialization", () => {
  beforeEach(() => {
    AISDKService.resetInstance();
  });

  // Generator for empty/whitespace-only strings
  const emptyStringArb = fc.oneof(
    fc.constant(""),
    fc.constant("   "),
    fc.constant("\t"),
    fc.constant("\n")
  );

  it("Property 2: isInitialized() returns false before initialization", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();
        expect(service.isInitialized()).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 3: getVLMClient() throws NOT_INITIALIZED before initialization", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        expect(() => service.getVLMClient()).toThrow(ServiceError);
        try {
          service.getVLMClient();
        } catch (error) {
          expect((error as ServiceError).code).toBe(ErrorCode.NOT_INITIALIZED);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 4: getTextClient() throws NOT_INITIALIZED before initialization", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        expect(() => service.getTextClient()).toThrow(ServiceError);
        try {
          service.getTextClient();
        } catch (error) {
          expect((error as ServiceError).code).toBe(ErrorCode.NOT_INITIALIZED);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 5: getEmbeddingClient() throws NOT_INITIALIZED before initialization", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        expect(() => service.getEmbeddingClient()).toThrow(ServiceError);
        try {
          service.getEmbeddingClient();
        } catch (error) {
          expect((error as ServiceError).code).toBe(ErrorCode.NOT_INITIALIZED);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 6: initialize() throws API_KEY_MISSING for empty apiKey", () => {
    fc.assert(
      fc.property(
        emptyStringArb,
        fc.webUrl(),
        fc.string({ minLength: 1 }),
        (apiKey, baseUrl, model) => {
          AISDKService.resetInstance();
          const service = AISDKService.getInstance();

          const config: UnifiedLLMConfig = {
            mode: "unified",
            config: { baseUrl, apiKey, model },
          };

          expect(() => service.initialize(config)).toThrow(ServiceError);
          try {
            service.initialize(config);
          } catch (error) {
            expect((error as ServiceError).code).toBe(ErrorCode.API_KEY_MISSING);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 7: Failed initialization leaves service in uninitialized state", () => {
    fc.assert(
      fc.property(
        emptyStringArb,
        fc.webUrl(),
        fc.string({ minLength: 1 }),
        (apiKey, baseUrl, model) => {
          AISDKService.resetInstance();
          const service = AISDKService.getInstance();

          const config: UnifiedLLMConfig = {
            mode: "unified",
            config: { baseUrl, apiKey, model },
          };

          try {
            service.initialize(config);
          } catch {
            // Expected
          }

          expect(service.isInitialized()).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Feature: llm-configuration, Property 7: Client type separation
 * Validates: Requirements 8.4
 */
describe("AISDKService Client Type Separation", () => {
  beforeEach(() => {
    AISDKService.resetInstance();
  });

  // Generator for valid endpoint configuration
  const endpointConfigArb = fc.record({
    baseUrl: fc.webUrl(),
    apiKey: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
    model: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  });

  // Generator for SeparateLLMConfig
  const separateLLMConfigArb = fc
    .tuple(endpointConfigArb, endpointConfigArb, endpointConfigArb)
    .map(
      ([vlm, textLlm, embeddingLlm]): SeparateLLMConfig => ({
        mode: "separate",
        vlm,
        textLlm,
        embeddingLlm,
      })
    );

  // Generator for UnifiedLLMConfig
  const unifiedLLMConfigArb = endpointConfigArb.map(
    (config): UnifiedLLMConfig => ({
      mode: "unified",
      config,
    })
  );

  it("Property 8: Unified mode initializes all clients", () => {
    fc.assert(
      fc.property(unifiedLLMConfigArb, (config) => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        service.initialize(config);

        expect(service.isInitialized()).toBe(true);
        // All client getters should not throw
        expect(() => service.getVLMClient()).not.toThrow();
        expect(() => service.getTextClient()).not.toThrow();
        expect(() => service.getEmbeddingClient()).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });

  it("Property 9: Separate mode initializes all clients with distinct configs", () => {
    fc.assert(
      fc.property(separateLLMConfigArb, (config) => {
        AISDKService.resetInstance();
        const service = AISDKService.getInstance();

        service.initialize(config);

        expect(service.isInitialized()).toBe(true);
        // All client getters should not throw
        expect(() => service.getVLMClient()).not.toThrow();
        expect(() => service.getTextClient()).not.toThrow();
        expect(() => service.getEmbeddingClient()).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });
});
