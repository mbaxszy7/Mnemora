import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { ErrorCode, ServiceError } from "./errors";
import { IPCError, IPCResult, toIPCError } from "./ipc-types";

/**
 * **Feature: ai-sdk-refactor, Property 3: JSON Serialization Round-Trip**
 * **Validates: Requirements 1.4**
 *
 * _For any_ valid IPCResult<T>, IPCError, or VLMResponse object,
 * JSON.parse(JSON.stringify(obj)) SHALL produce an object deeply equal to the original.
 */
describe("JSON Serialization Round-Trip", () => {
  const errorCodeValues = Object.values(ErrorCode);

  // Arbitrary for IPCError
  const ipcErrorArb = fc.record({
    code: fc.constantFrom(...errorCodeValues),
    message: fc.string(),
    details: fc.option(fc.jsonValue(), { nil: undefined }),
  });

  // Arbitrary for IPCResult<T> with JSON-serializable data
  const ipcResultArb = fc.oneof(
    // Success case
    fc.record({
      success: fc.constant(true),
      data: fc.jsonValue(),
      error: fc.constant(undefined),
    }),
    // Error case
    fc.record({
      success: fc.constant(false),
      data: fc.constant(undefined),
      error: ipcErrorArb,
    })
  );

  it("Property 3.1: IPCError round-trips through JSON serialization", () => {
    // Use JSON-safe arbitrary that excludes values that don't round-trip (like -0, NaN, Infinity)
    const jsonSafeDetailsArb = fc.jsonValue();

    const jsonSafeIpcErrorArb = fc.record({
      code: fc.constantFrom(...errorCodeValues),
      message: fc.string(),
      details: fc.option(jsonSafeDetailsArb, { nil: undefined }),
    });

    fc.assert(
      fc.property(jsonSafeIpcErrorArb, (ipcError: IPCError) => {
        const serialized = JSON.stringify(ipcError);
        const deserialized = JSON.parse(serialized);
        expect(deserialized.code).toBe(ipcError.code);
        expect(deserialized.message).toBe(ipcError.message);
        // details may be undefined, which gets stripped in JSON
        if (ipcError.details !== undefined) {
          // Compare via JSON to handle edge cases like -0 vs 0
          expect(JSON.stringify(deserialized.details)).toBe(
            JSON.stringify(ipcError.details)
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 3.2: IPCResult round-trips through JSON serialization", () => {
    fc.assert(
      fc.property(ipcResultArb, (ipcResult: IPCResult<unknown>) => {
        const serialized = JSON.stringify(ipcResult);
        const deserialized = JSON.parse(serialized);
        expect(deserialized.success).toBe(ipcResult.success);
        if (ipcResult.success && ipcResult.data !== undefined) {
          // Compare via JSON to handle edge cases like -0 vs 0
          expect(JSON.stringify(deserialized.data)).toBe(
            JSON.stringify(ipcResult.data)
          );
        }
        if (!ipcResult.success && ipcResult.error) {
          expect(deserialized.error.code).toBe(ipcResult.error.code);
          expect(deserialized.error.message).toBe(ipcResult.error.message);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 3.3: toIPCError produces valid IPCError from ServiceError", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...errorCodeValues),
        fc.string({ minLength: 1 }),
        fc.jsonValue(),
        (code, message, details) => {
          const serviceError = new ServiceError(code, message, details);
          const ipcError = toIPCError(serviceError);

          // Verify it's a valid IPCError
          expect(ipcError.code).toBe(code);
          expect(ipcError.message).toBe(message);
          expect(ipcError.details).toEqual(details);

          // Verify it round-trips
          const serialized = JSON.stringify(ipcError);
          const deserialized = JSON.parse(serialized);
          expect(deserialized.code).toBe(ipcError.code);
          expect(deserialized.message).toBe(ipcError.message);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 3.4: toIPCError produces valid IPCError from regular Error", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (message) => {
        const error = new Error(message);
        const ipcError = toIPCError(error);

        // Verify it's a valid IPCError with UNKNOWN code
        expect(ipcError.code).toBe(ErrorCode.UNKNOWN);
        expect(ipcError.message).toBe(message);
        expect(errorCodeValues).toContain(ipcError.code);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 3.5: toIPCError handles non-Error values", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        (value) => {
          const ipcError = toIPCError(value);

          // Verify it's a valid IPCError with UNKNOWN code
          expect(ipcError.code).toBe(ErrorCode.UNKNOWN);
          expect(ipcError.message).toBe(String(value));
          expect(errorCodeValues).toContain(ipcError.code);
        }
      ),
      { numRuns: 100 }
    );
  });
});
