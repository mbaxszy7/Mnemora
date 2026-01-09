import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeepSearchService } from "./deep-search-service";
import type { ExpandedContextNode, ScreenshotEvidence, SearchFilters } from "./types";

// ============================================================================
// Mock Setup
// ============================================================================

vi.mock("../ai-sdk-service", () => ({
  AISDKService: {
    getInstance: vi.fn(() => ({
      isInitialized: vi.fn(() => false),
      getTextClient: vi.fn(),
      getTextModelName: vi.fn(() => "test-model"),
    })),
  },
}));

vi.mock("../usage/llm-usage-service", () => ({
  llmUsageService: {
    logEvent: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("DeepSearchService", () => {
  let service: DeepSearchService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DeepSearchService();
  });

  describe("mergeFilters", () => {
    it("should return original filters when queryPlan is null", () => {
      const userFilters: SearchFilters = {
        threadId: "thread_123",
        timeRange: { start: 1000, end: 2000 },
      };

      const result = service.mergeFilters(userFilters, null);

      expect(result).toEqual(userFilters);
    });

    it("should return original filters when queryPlan has low confidence", () => {
      const userFilters: SearchFilters = {};
      const queryPlan = {
        embeddingText: "test",
        confidence: 0.3, // Below threshold of 0.5
        filtersPatch: {
          appHint: "Notes",
          timeRange: { start: 1000, end: 2000 },
        },
      };

      const result = service.mergeFilters(userFilters, queryPlan);

      expect(result).toEqual({});
      expect(result.appHint).toBeUndefined();
      expect(result.timeRange).toBeUndefined();
    });

    it("should merge filtersPatch when confidence is high", () => {
      const userFilters: SearchFilters = {};
      const queryPlan = {
        embeddingText: "test",
        confidence: 0.8,
        filtersPatch: {
          appHint: "Notes",
          timeRange: { start: 1000, end: 2000 },
        },
      };

      const result = service.mergeFilters(userFilters, queryPlan);

      expect(result.appHint).toBe("Notes");
      expect(result.timeRange).toEqual({ start: 1000, end: 2000 });
    });

    it("should NOT overwrite user-provided filters", () => {
      const userFilters: SearchFilters = {
        appHint: "UserApp",
        timeRange: { start: 500, end: 600 },
      };
      const queryPlan = {
        embeddingText: "test",
        confidence: 0.9,
        filtersPatch: {
          appHint: "LLMApp",
          timeRange: { start: 1000, end: 2000 },
        },
      };

      const result = service.mergeFilters(userFilters, queryPlan);

      expect(result.appHint).toBe("UserApp");
      expect(result.timeRange).toEqual({ start: 500, end: 600 });
    });

    it("should NEVER touch user threadId", () => {
      const userFilters: SearchFilters = {
        threadId: "user_thread",
      };
      // Note: threadId is not allowed in filtersPatch per schema
      const queryPlan = {
        embeddingText: "test",
        confidence: 0.9,
        filtersPatch: {},
      };

      const result = service.mergeFilters(userFilters, queryPlan);

      expect(result.threadId).toBe("user_thread");
    });

    it("should combine entities from both sources", () => {
      const userFilters: SearchFilters = {
        entities: ["Entity1", "Entity2"],
      };
      const queryPlan = {
        embeddingText: "test",
        confidence: 0.8,
        filtersPatch: {
          entities: ["Entity2", "Entity3"],
        },
      };

      const result = service.mergeFilters(userFilters, queryPlan);

      expect(result.entities).toEqual(["Entity1", "Entity2", "Entity3"]);
    });
  });

  describe("understandQuery", () => {
    it("should return null when AI SDK is not initialized", async () => {
      const result = await service.understandQuery("test query", Date.now(), "UTC");

      expect(result).toBeNull();
    });
  });

  describe("synthesizeAnswer", () => {
    it("should return null when nodes array is empty", async () => {
      const result = await service.synthesizeAnswer("test query", [], [], Date.now(), "UTC");

      expect(result).toBeNull();
    });

    it("should return null when AI SDK is not initialized", async () => {
      const testNodes: ExpandedContextNode[] = [
        {
          id: 1,
          kind: "event",
          title: "Test Event",
          summary: "Test summary",
          keywords: [],
          entities: [],
          importance: 5,
          confidence: 5,
          screenshotIds: [100],
        },
      ];
      const testEvidence: ScreenshotEvidence[] = [
        {
          screenshotId: 100,
          timestamp: 1000,
        },
      ];

      const result = await service.synthesizeAnswer(
        "test query",
        testNodes,
        testEvidence,
        Date.now(),
        "UTC"
      );

      expect(result).toBeNull();
    });
  });
});
