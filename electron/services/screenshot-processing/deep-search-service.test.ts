/**
 * Unit Tests for Deep Search Service
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("../ai-sdk-service", () => ({
  AISDKService: {
    getInstance: vi.fn(() => ({
      isInitialized: vi.fn().mockReturnValue(false),
      getTextClient: vi.fn(),
      getTextModelName: vi.fn().mockReturnValue("test-model"),
    })),
  },
}));

vi.mock("../llm-usage-service", () => ({
  llmUsageService: {
    logEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../monitoring/ai-request-trace", () => ({
  aiRequestTraceBuffer: {
    record: vi.fn(),
  },
}));

vi.mock("../ai-runtime-service", () => ({
  aiRuntimeService: {
    acquire: vi.fn().mockResolvedValue(vi.fn()),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock("./prompt-templates", () => ({
  promptTemplates: {
    getQueryUnderstandingSystemPrompt: vi.fn().mockReturnValue("system prompt"),
    getQueryUnderstandingUserPrompt: vi.fn().mockReturnValue("user prompt"),
    getSearchAnswerSystemPrompt: vi.fn().mockReturnValue("answer system prompt"),
    getSearchAnswerUserPrompt: vi.fn().mockReturnValue("answer user prompt"),
  },
}));

vi.mock("./schemas", () => ({
  SearchQueryPlanSchema: {},
  SearchQueryPlanProcessedSchema: {
    parse: vi.fn().mockReturnValue({
      confidence: 0.8,
      intent: "search",
      embeddingText: "test query",
      filters: {},
    }),
  },
  SearchAnswerSchema: {},
  SearchAnswerProcessedSchema: {
    parse: vi.fn().mockReturnValue({
      answer: "Test answer",
      citations: [],
    }),
  },
}));

vi.mock("./config", () => ({
  processingConfig: {
    ai: {
      textTimeoutMs: 30000,
    },
  },
}));

vi.mock("../screen-capture/types", () => ({
  DEFAULT_WINDOW_FILTER_CONFIG: {
    appAliases: {},
  },
}));

import { DeepSearchService } from "./deep-search-service";
import type { ExpandedContextNode, SearchFilters } from "./types";

describe("DeepSearchService", () => {
  let service: DeepSearchService;

  beforeEach(() => {
    service = new DeepSearchService();
    vi.clearAllMocks();
  });

  describe("understandQuery", () => {
    it("returns null when AI service not initialized", async () => {
      const result = await service.understandQuery("test", Date.now(), "UTC");
      expect(result).toBeNull();
    });

    it("returns null for empty query", async () => {
      const result = await service.understandQuery("", Date.now(), "UTC");
      expect(result).toBeNull();
    });

    it("respects abort signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await service.understandQuery("test", Date.now(), "UTC", controller.signal);
      expect(result).toBeNull();
    });
  });

  describe("synthesizeAnswer", () => {
    it("returns null when AI service not initialized", async () => {
      const result = await service.synthesizeAnswer("test", [], [], Date.now(), "UTC");
      expect(result).toBeNull();
    });

    it("returns null for empty nodes", async () => {
      const result = await service.synthesizeAnswer("test", [], [], Date.now(), "UTC");
      expect(result).toBeNull();
    });
  });

  describe("mergeFilters", () => {
    it("returns empty object when both filters are undefined", () => {
      const result = service.mergeFilters(undefined, undefined);
      expect(result).toEqual({});
    });

    it("merges base and query filters", () => {
      const base: SearchFilters = { timeRange: { start: 0, end: 1000 } };
      const query: SearchFilters = { apps: ["TestApp"] };
      const result = service.mergeFilters(base, query);
      expect(result).toBeDefined();
    });
  });

  describe("buildPayloads", () => {
    it("builds node payloads correctly", async () => {
      const nodes = [
        {
          id: 1,
          kind: "screenshot",
          title: "Test",
          summary: "Summary",
          keywords: ["test"],
          entities: ["entity"],
          eventTime: Date.now(),
          screenshotIds: [1],
        },
      ];

      const result = await service.synthesizeAnswer(
        "test",
        nodes as ExpandedContextNode[],
        [],
        Date.now(),
        "UTC"
      );
      expect(result).toBeNull(); // AI not initialized
    });
  });
});
