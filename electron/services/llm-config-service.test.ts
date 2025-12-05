/**
 * LLMConfigService Unit Tests
 * Tests for configuration loading, saving, and error code mapping
 * Requirements: 5.1, 5.2, 4.5
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { LLMConfigService } from "./llm-config-service";
import { LLMValidationErrorCode } from "@shared/llm-config-types";

// Mock the database module
vi.mock("../database", () => {
  let mockRecord: Record<string, unknown> | null = null;

  return {
    db: {
      select: () => ({
        from: () => ({
          get: () => mockRecord,
        }),
      }),
      insert: () => ({
        values: (data: Record<string, unknown>) => ({
          run: () => {
            mockRecord = { id: 1, ...data, createdAt: new Date(), updatedAt: new Date() };
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            run: () => {},
          }),
        }),
      }),
    },
    llmConfig: {},
    __setMockRecord: (record: Record<string, unknown> | null) => {
      mockRecord = record;
    },
    __clearMockRecord: () => {
      mockRecord = null;
    },
  };
});

// Mock the logger
vi.mock("./logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("LLMConfigService", () => {
  beforeEach(() => {
    LLMConfigService.resetInstance();
  });

  describe("Singleton Pattern", () => {
    it("should return the same instance on multiple calls", () => {
      const instance1 = LLMConfigService.getInstance();
      const instance2 = LLMConfigService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it("should create new instance after reset", () => {
      const instance1 = LLMConfigService.getInstance();
      LLMConfigService.resetInstance();
      const instance2 = LLMConfigService.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("checkConfiguration", () => {
    it("should return configured: false when no configuration exists", async () => {
      const service = LLMConfigService.getInstance();
      const result = await service.checkConfiguration();
      expect(result.configured).toBe(false);
      expect(result.config).toBeUndefined();
    });
  });

  describe("loadConfiguration", () => {
    it("should return null when no record exists", async () => {
      const service = LLMConfigService.getInstance();
      const result = await service.loadConfiguration();
      expect(result).toBeNull();
    });
  });
});

describe("Error Code Mapping", () => {
  /**
   * Test error code mapping logic
   * Requirements: 4.5, 4.6, 4.7
   */

  // Access private method via prototype for testing
  const getMapErrorToCode = () => {
    const service = LLMConfigService.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (service as any).mapErrorToCode.bind(service);
  };

  beforeEach(() => {
    LLMConfigService.resetInstance();
  });

  it("should map network errors correctly", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("network error"))).toBe(LLMValidationErrorCode.NETWORK_ERROR);
    expect(mapErrorToCode(new Error("ECONNREFUSED"))).toBe(LLMValidationErrorCode.NETWORK_ERROR);
    expect(mapErrorToCode(new Error("ENOTFOUND"))).toBe(LLMValidationErrorCode.NETWORK_ERROR);
  });

  it("should map timeout errors correctly", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("request timeout"))).toBe(LLMValidationErrorCode.TIMEOUT);
    expect(mapErrorToCode(new Error("timed out"))).toBe(LLMValidationErrorCode.TIMEOUT);
  });

  it("should map 404 errors correctly", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("404 not found"))).toBe(LLMValidationErrorCode.NOT_FOUND_404);
    expect(mapErrorToCode(new Error("endpoint not found"))).toBe(
      LLMValidationErrorCode.NOT_FOUND_404
    );
  });

  it("should map 401 unauthorized errors correctly", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("401 unauthorized"))).toBe(
      LLMValidationErrorCode.UNAUTHORIZED_401
    );
    expect(mapErrorToCode(new Error("invalid api key"))).toBe(
      LLMValidationErrorCode.UNAUTHORIZED_401
    );
    expect(mapErrorToCode(new Error("incorrect api key"))).toBe(
      LLMValidationErrorCode.UNAUTHORIZED_401
    );
  });

  it("should map vision not supported errors correctly", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("image not supported"), true)).toBe(
      LLMValidationErrorCode.VISION_NOT_SUPPORTED
    );
    expect(mapErrorToCode(new Error("vision capability unsupported"), true)).toBe(
      LLMValidationErrorCode.VISION_NOT_SUPPORTED
    );
  });

  it("should map embedding not supported errors correctly", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("embedding not supported"), false, true)).toBe(
      LLMValidationErrorCode.EMBEDDING_NOT_SUPPORTED
    );
  });

  it("should map invalid response errors correctly", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("invalid json response"))).toBe(
      LLMValidationErrorCode.INVALID_RESPONSE
    );
    expect(mapErrorToCode(new Error("parse error"))).toBe(LLMValidationErrorCode.INVALID_RESPONSE);
  });

  it("should return UNKNOWN for unrecognized errors", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("some random error"))).toBe(LLMValidationErrorCode.UNKNOWN);
    expect(mapErrorToCode("not an error object")).toBe(LLMValidationErrorCode.UNKNOWN);
    expect(mapErrorToCode(null)).toBe(LLMValidationErrorCode.UNKNOWN);
  });
});
