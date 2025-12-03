import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { ErrorCode, ERROR_MESSAGES, getErrorMessage, ServiceError } from "./errors";

/**
 * **Feature: ai-sdk-refactor, Property 4: Error System Consistency**
 * **Validates: Requirements 4.1, 4.3, 4.4, 3.3**
 *
 * _For any_ ErrorCode value, getErrorMessage() SHALL return a non-empty user-friendly string.
 * _For any_ ServiceError or Error, toIPCError() SHALL produce a valid IPCError with a code from ErrorCode enum.
 */
describe("Error System Consistency", () => {
  // Get all ErrorCode values
  const errorCodeValues = Object.values(ErrorCode);

  it("Property 4.1: Every ErrorCode has a corresponding non-empty message in ERROR_MESSAGES", () => {
    fc.assert(
      fc.property(fc.constantFrom(...errorCodeValues), (code) => {
        const message = ERROR_MESSAGES[code];
        expect(message).toBeDefined();
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 4.2: getErrorMessage returns non-empty string for any ErrorCode", () => {
    fc.assert(
      fc.property(fc.constantFrom(...errorCodeValues), (code) => {
        const message = getErrorMessage(code);
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 4.3: getErrorMessage returns UNKNOWN message for invalid codes", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !errorCodeValues.includes(s as ErrorCode)),
        (invalidCode) => {
          const message = getErrorMessage(invalidCode);
          expect(message).toBe(ERROR_MESSAGES[ErrorCode.UNKNOWN]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 4.4: ServiceError preserves code, message, and details", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...errorCodeValues),
        fc.string({ minLength: 1 }),
        fc.anything(),
        (code, message, details) => {
          const error = new ServiceError(code, message, details);
          expect(error.code).toBe(code);
          expect(error.message).toBe(message);
          expect(error.details).toEqual(details);
          expect(error.name).toBe("ServiceError");
          expect(error instanceof Error).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
