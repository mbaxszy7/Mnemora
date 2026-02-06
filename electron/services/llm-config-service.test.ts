/**
 * LLMConfigService Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { LLMConfigService } from "./llm-config-service";
import { LLMValidationErrorCode } from "@shared/llm-config-types";
import type { LLMConfig } from "@shared/llm-config-types";

const { mockDbRecord } = vi.hoisted(() => ({
  mockDbRecord: { current: null as Record<string, unknown> | null },
}));

vi.mock("../database", () => ({
  getDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        get: () => mockDbRecord.current,
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        run: () => {
          mockDbRecord.current = { id: 1, ...data, createdAt: new Date(), updatedAt: new Date() };
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
  })),
  llmConfig: {},
}));

vi.mock("./logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./ai-sdk-service", () => ({
  AISDKService: {
    getInstance: vi.fn(() => ({
      initialize: vi.fn(),
      isInitialized: vi.fn(() => true),
      getTextClient: vi.fn(() => ({})),
      getVLMClient: vi.fn(() => ({})),
      getEmbeddingClient: vi.fn(() => ({})),
    })),
  },
}));

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "hello" })),
  embed: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
}));

describe("LLMConfigService", () => {
  beforeEach(() => {
    LLMConfigService.resetInstance();
    mockDbRecord.current = null;
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

  describe("loadConfiguration", () => {
    it("should return null when no record exists", async () => {
      const service = LLMConfigService.getInstance();
      const result = await service.loadConfiguration();
      expect(result).toBeNull();
    });

    it("should load unified config from DB record", async () => {
      mockDbRecord.current = {
        id: 1,
        mode: "unified",
        unifiedBaseUrl: "https://api.test.com",
        unifiedApiKey: btoa("sk-test"),
        unifiedModel: "gpt-4",
        language: "en",
        vlmBaseUrl: null,
        vlmApiKey: null,
        vlmModel: null,
        textLlmBaseUrl: null,
        textLlmApiKey: null,
        textLlmModel: null,
        embeddingBaseUrl: null,
        embeddingApiKey: null,
        embeddingModel: null,
      };
      const service = LLMConfigService.getInstance();
      const config = await service.loadConfiguration();
      expect(config).not.toBeNull();
      expect(config!.mode).toBe("unified");
    });

    it("should load separate config from DB record", async () => {
      mockDbRecord.current = {
        id: 1,
        mode: "separate",
        unifiedBaseUrl: null,
        unifiedApiKey: null,
        unifiedModel: null,
        vlmBaseUrl: "https://vlm.test.com",
        vlmApiKey: btoa("sk-vlm"),
        vlmModel: "vlm-model",
        textLlmBaseUrl: "https://text.test.com",
        textLlmApiKey: btoa("sk-text"),
        textLlmModel: "text-model",
        embeddingBaseUrl: "https://embed.test.com",
        embeddingApiKey: btoa("sk-embed"),
        embeddingModel: "embed-model",
        language: "zh-CN",
      };
      const service = LLMConfigService.getInstance();
      const config = await service.loadConfiguration();
      expect(config).not.toBeNull();
      expect(config!.mode).toBe("separate");
    });

    it("returns null for incomplete unified record", async () => {
      mockDbRecord.current = {
        id: 1,
        mode: "unified",
        unifiedBaseUrl: null,
        unifiedApiKey: null,
        unifiedModel: null,
      };
      const service = LLMConfigService.getInstance();
      const config = await service.loadConfiguration();
      expect(config).toBeNull();
    });

    it("returns null for incomplete separate record", async () => {
      mockDbRecord.current = {
        id: 1,
        mode: "separate",
        vlmBaseUrl: "https://vlm.test.com",
        vlmApiKey: btoa("sk-vlm"),
        vlmModel: "vlm-model",
        textLlmBaseUrl: null,
        textLlmApiKey: null,
        textLlmModel: null,
        embeddingBaseUrl: null,
        embeddingApiKey: null,
        embeddingModel: null,
      };
      const service = LLMConfigService.getInstance();
      const config = await service.loadConfiguration();
      expect(config).toBeNull();
    });
  });

  describe("checkConfiguration", () => {
    it("returns configured: false when no config", async () => {
      const service = LLMConfigService.getInstance();
      const result = await service.checkConfiguration();
      expect(result.configured).toBe(false);
    });

    it("returns configured: true for complete unified config", async () => {
      mockDbRecord.current = {
        id: 1,
        mode: "unified",
        unifiedBaseUrl: "https://api.test.com",
        unifiedApiKey: btoa("sk-test"),
        unifiedModel: "gpt-4",
        language: "en",
      };
      const service = LLMConfigService.getInstance();
      const result = await service.checkConfiguration();
      expect(result.configured).toBe(true);
      expect(result.config).toBeDefined();
    });
  });

  describe("saveConfiguration", () => {
    it("inserts new record when none exists", async () => {
      const service = LLMConfigService.getInstance();
      const config: LLMConfig = {
        mode: "unified",
        config: { baseUrl: "https://api.test.com", apiKey: "sk-test", model: "gpt-4" },
        language: "en",
      };
      await service.saveConfiguration(config);
      expect(mockDbRecord.current).not.toBeNull();
    });

    it("updates existing record", async () => {
      mockDbRecord.current = { id: 1, mode: "unified" };
      const service = LLMConfigService.getInstance();
      const config: LLMConfig = {
        mode: "unified",
        config: { baseUrl: "https://api.test.com", apiKey: "sk-test", model: "gpt-4" },
        language: "en",
      };
      await service.saveConfiguration(config);
    });

    it("saves separate mode config", async () => {
      const service = LLMConfigService.getInstance();
      const config: LLMConfig = {
        mode: "separate",
        vlm: { baseUrl: "https://vlm.test.com", apiKey: "sk-vlm", model: "vlm" },
        textLlm: { baseUrl: "https://text.test.com", apiKey: "sk-text", model: "text" },
        embeddingLlm: { baseUrl: "https://embed.test.com", apiKey: "sk-embed", model: "embed" },
        language: "zh-CN",
      };
      await service.saveConfiguration(config);
      expect(mockDbRecord.current).not.toBeNull();
    });
  });

  describe("validateConfiguration", () => {
    it("returns success for valid configuration", async () => {
      const service = LLMConfigService.getInstance();
      const config: LLMConfig = {
        mode: "unified",
        config: { baseUrl: "https://api.test.com", apiKey: "sk-test", model: "gpt-4" },
      };
      const result = await service.validateConfiguration(config);
      expect(result.success).toBe(true);
      expect(result.textCompletion!.success).toBe(true);
      expect(result.vision!.success).toBe(true);
      expect(result.embedding!.success).toBe(true);
    });

    it("restores previous config on validation failure", async () => {
      // Set up a "previous" config
      mockDbRecord.current = {
        id: 1,
        mode: "unified",
        unifiedBaseUrl: "https://api.old.com",
        unifiedApiKey: btoa("sk-old"),
        unifiedModel: "old-model",
        language: "en",
      };

      const { AISDKService } = await import("./ai-sdk-service");
      const mockInit = vi.fn();
      // Make initialize throw on first call (validation), succeed on restore
      let callCount = 0;
      mockInit.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("init failed");
      });
      vi.mocked(AISDKService.getInstance).mockReturnValue({
        initialize: mockInit,
        isInitialized: vi.fn(() => true),
        getTextClient: vi.fn(() => ({})),
        getVLMClient: vi.fn(() => ({})),
        getEmbeddingClient: vi.fn(() => ({})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const service = LLMConfigService.getInstance();
      const result = await service.validateConfiguration({
        mode: "unified",
        config: { baseUrl: "https://api.new.com", apiKey: "sk-new", model: "new" },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("checkConfiguration - separate mode", () => {
  beforeEach(() => {
    LLMConfigService.resetInstance();
    mockDbRecord.current = null;
  });

  it("returns configured: true for complete separate config", async () => {
    mockDbRecord.current = {
      id: 1,
      mode: "separate",
      vlmBaseUrl: "https://vlm.test.com",
      vlmApiKey: btoa("sk-vlm"),
      vlmModel: "vlm-model",
      textLlmBaseUrl: "https://text.test.com",
      textLlmApiKey: btoa("sk-text"),
      textLlmModel: "text-model",
      embeddingBaseUrl: "https://embed.test.com",
      embeddingApiKey: btoa("sk-embed"),
      embeddingModel: "embed-model",
      language: "zh-CN",
    };
    const service = LLMConfigService.getInstance();
    const result = await service.checkConfiguration();
    expect(result.configured).toBe(true);
  });

  it("returns configured: false for incomplete separate config (missing textLlm)", async () => {
    mockDbRecord.current = {
      id: 1,
      mode: "separate",
      vlmBaseUrl: "https://vlm.test.com",
      vlmApiKey: btoa("sk-vlm"),
      vlmModel: "vlm-model",
      textLlmBaseUrl: null,
      textLlmApiKey: null,
      textLlmModel: null,
      embeddingBaseUrl: "https://embed.test.com",
      embeddingApiKey: btoa("sk-embed"),
      embeddingModel: "embed-model",
    };
    const service = LLMConfigService.getInstance();
    const result = await service.checkConfiguration();
    expect(result.configured).toBe(false);
  });

  it("returns configured: false for incomplete separate config (missing embeddingLlm)", async () => {
    mockDbRecord.current = {
      id: 1,
      mode: "separate",
      vlmBaseUrl: "https://vlm.test.com",
      vlmApiKey: btoa("sk-vlm"),
      vlmModel: "vlm-model",
      textLlmBaseUrl: "https://text.test.com",
      textLlmApiKey: btoa("sk-text"),
      textLlmModel: "text-model",
      embeddingBaseUrl: null,
      embeddingApiKey: null,
      embeddingModel: null,
    };
    const service = LLMConfigService.getInstance();
    const result = await service.checkConfiguration();
    expect(result.configured).toBe(false);
  });
});

describe("loadConfiguration language fallback", () => {
  beforeEach(() => {
    LLMConfigService.resetInstance();
    mockDbRecord.current = null;
  });

  it("falls back to en when language is null in unified config", async () => {
    mockDbRecord.current = {
      id: 1,
      mode: "unified",
      unifiedBaseUrl: "https://api.test.com",
      unifiedApiKey: btoa("sk-test"),
      unifiedModel: "gpt-4",
      language: null,
    };
    const service = LLMConfigService.getInstance();
    const config = await service.loadConfiguration();
    expect(config!.language).toBe("en");
  });

  it("falls back to en when language is null in separate config", async () => {
    mockDbRecord.current = {
      id: 1,
      mode: "separate",
      vlmBaseUrl: "https://vlm.test.com",
      vlmApiKey: btoa("sk-vlm"),
      vlmModel: "vlm",
      textLlmBaseUrl: "https://text.test.com",
      textLlmApiKey: btoa("sk-text"),
      textLlmModel: "text",
      embeddingBaseUrl: "https://embed.test.com",
      embeddingApiKey: btoa("sk-embed"),
      embeddingModel: "embed",
      language: null,
    };
    const service = LLMConfigService.getInstance();
    const config = await service.loadConfiguration();
    expect(config!.language).toBe("en");
  });
});

describe("saveConfiguration language fallback", () => {
  beforeEach(() => {
    LLMConfigService.resetInstance();
    mockDbRecord.current = null;
  });

  it("falls back to en for unified config without language", async () => {
    const service = LLMConfigService.getInstance();
    await service.saveConfiguration({
      mode: "unified",
      config: { baseUrl: "https://api.test.com", apiKey: "sk-test", model: "gpt-4" },
    });
    expect(mockDbRecord.current).not.toBeNull();
  });

  it("falls back to en for separate config without language", async () => {
    const service = LLMConfigService.getInstance();
    await service.saveConfiguration({
      mode: "separate",
      vlm: { baseUrl: "https://vlm.test.com", apiKey: "sk-vlm", model: "vlm" },
      textLlm: { baseUrl: "https://text.test.com", apiKey: "sk-text", model: "text" },
      embeddingLlm: { baseUrl: "https://embed.test.com", apiKey: "sk-embed", model: "embed" },
    });
    expect(mockDbRecord.current).not.toBeNull();
  });
});

describe("validateConfiguration edge cases", () => {
  beforeEach(() => {
    LLMConfigService.resetInstance();
    mockDbRecord.current = null;
  });

  it("does not restore when validation fails and no previous config", async () => {
    const { AISDKService } = await import("./ai-sdk-service");
    const { generateText } = await import("ai");

    vi.mocked(generateText).mockRejectedValue(new Error("API error"));
    vi.mocked(AISDKService.getInstance).mockReturnValue({
      initialize: vi.fn(),
      isInitialized: vi.fn(() => true),
      getTextClient: vi.fn(() => ({})),
      getVLMClient: vi.fn(() => ({})),
      getEmbeddingClient: vi.fn(() => ({})),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const service = LLMConfigService.getInstance();
    const result = await service.validateConfiguration({
      mode: "unified",
      config: { baseUrl: "https://api.test.com", apiKey: "sk-test", model: "gpt-4" },
    });
    expect(result.success).toBe(false);
  });
});

describe("Error Code Mapping", () => {
  /**
   * Test error code mapping logic
   * Test error code mapping logic
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

  it("should map fetch error name to NETWORK_ERROR", () => {
    const mapErrorToCode = getMapErrorToCode();
    const err = new Error("something failed");
    err.name = "FetchError";
    expect(mapErrorToCode(err)).toBe(LLMValidationErrorCode.NETWORK_ERROR);
  });

  it("should map vision 'does not support' to VISION_NOT_SUPPORTED", () => {
    const mapErrorToCode = getMapErrorToCode();
    expect(mapErrorToCode(new Error("model does not support this feature"), true)).toBe(
      LLMValidationErrorCode.VISION_NOT_SUPPORTED
    );
  });

  it("should NOT map 'does not support' to VISION when not vision validation", () => {
    const mapErrorToCode = getMapErrorToCode();
    // Without isVisionValidation=true, it should fall through to INVALID_RESPONSE or UNKNOWN
    expect(mapErrorToCode(new Error("does not support"))).not.toBe(
      LLMValidationErrorCode.VISION_NOT_SUPPORTED
    );
  });

  it("should map embedding 'does not support' to EMBEDDING_NOT_SUPPORTED", () => {
    const mapErrorToCode = getMapErrorToCode();
    expect(mapErrorToCode(new Error("model does not support embeddings"), false, true)).toBe(
      LLMValidationErrorCode.EMBEDDING_NOT_SUPPORTED
    );
  });

  it("should map embedding 'unsupported' to EMBEDDING_NOT_SUPPORTED", () => {
    const mapErrorToCode = getMapErrorToCode();
    expect(mapErrorToCode(new Error("unsupported operation"), false, true)).toBe(
      LLMValidationErrorCode.EMBEDDING_NOT_SUPPORTED
    );
  });

  it("should return UNKNOWN for unrecognized errors", () => {
    const mapErrorToCode = getMapErrorToCode();

    expect(mapErrorToCode(new Error("some random error"))).toBe(LLMValidationErrorCode.UNKNOWN);
    expect(mapErrorToCode("not an error object")).toBe(LLMValidationErrorCode.UNKNOWN);
    expect(mapErrorToCode(null)).toBe(LLMValidationErrorCode.UNKNOWN);
  });
});
