import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockGenerateObject = vi.hoisted(() => vi.fn());

const mockAi = vi.hoisted(() => ({
  isInitialized: vi.fn(() => false),
  getTextClient: vi.fn(() => ({})),
  getTextModelName: vi.fn(() => "test-model"),
}));

const mockLlmUsage = vi.hoisted(() => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

const mockAiRequestTrace = vi.hoisted(() => ({
  record: vi.fn(),
}));

const mockAiRuntime = vi.hoisted(() => ({
  acquire: vi.fn().mockResolvedValue(vi.fn()),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));

const mockPromptTemplates = vi.hoisted(() => ({
  getQueryUnderstandingSystemPrompt: vi.fn(() => "system prompt"),
  getQueryUnderstandingUserPrompt: vi.fn(() => "user prompt"),
  getAnswerSynthesisSystemPrompt: vi.fn(() => "answer system prompt"),
  getAnswerSynthesisUserPrompt: vi.fn(() => "answer user prompt"),
}));

const mockQueryPlanParse = vi.hoisted(() => vi.fn());
const mockAnswerParse = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("../ai-sdk-service", () => ({ AISDKService: { getInstance: vi.fn(() => mockAi) } }));
vi.mock("../llm-usage-service", () => ({ llmUsageService: mockLlmUsage }));
vi.mock("../monitoring/ai-request-trace", () => ({ aiRequestTraceBuffer: mockAiRequestTrace }));
vi.mock("../ai-runtime-service", () => ({ aiRuntimeService: mockAiRuntime }));
vi.mock("./prompt-templates", () => ({ promptTemplates: mockPromptTemplates }));
vi.mock("./schemas", () => ({
  SearchQueryPlanSchema: {},
  SearchQueryPlanProcessedSchema: { parse: mockQueryPlanParse },
  SearchAnswerSchema: {},
  SearchAnswerProcessedSchema: { parse: mockAnswerParse },
}));
vi.mock("./config", () => ({ processingConfig: { ai: { textTimeoutMs: 1000 } } }));
vi.mock("../screen-capture/types", () => ({
  DEFAULT_WINDOW_FILTER_CONFIG: {
    appAliases: {
      vscode: ["Code", "Visual Studio Code"],
    },
  },
}));

import { DeepSearchService } from "./deep-search-service";
import type {
  ExpandedContextNode,
  ScreenshotEvidence,
  SearchFilters,
  SearchQueryPlan,
} from "./types";

describe("DeepSearchService", () => {
  let service: DeepSearchService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAi.isInitialized.mockReturnValue(false);

    mockQueryPlanParse.mockReturnValue({
      embeddingText: "test query",
      confidence: 0.8,
      filtersPatch: {},
    } satisfies SearchQueryPlan);

    mockAnswerParse.mockReturnValue({
      answer: "Test answer",
      citations: [],
      confidence: 0.9,
    });

    service = new DeepSearchService();
  });

  describe("understandQuery", () => {
    it("returns null when AI service not initialized", async () => {
      const result = await service.understandQuery("test", Date.now(), "UTC");
      expect(result).toBeNull();
      expect(mockGenerateObject).not.toHaveBeenCalled();
    });

    it("returns parsed query plan on success", async () => {
      mockAi.isInitialized.mockReturnValue(true);
      mockGenerateObject.mockResolvedValueOnce({
        object: { any: "raw" },
        usage: { totalTokens: 42 },
      });

      const plan = await service.understandQuery("where did I edit docs?", 10_000, "UTC");
      expect(plan).toEqual(
        expect.objectContaining({ embeddingText: "test query", confidence: 0.8 })
      );
      expect(mockQueryPlanParse).toHaveBeenCalledWith({ any: "raw" });
      expect(mockLlmUsage.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "deep_search_understand_query",
          status: "succeeded",
          totalTokens: 42,
          usageStatus: "present",
        })
      );
      expect(mockAiRuntime.recordSuccess).toHaveBeenCalledWith("text");
    });

    it("returns null on generateObject error", async () => {
      mockAi.isInitialized.mockReturnValue(true);
      mockGenerateObject.mockRejectedValueOnce(new Error("boom"));

      const plan = await service.understandQuery("test", 10_000, "UTC");
      expect(plan).toBeNull();
      expect(mockAiRuntime.recordFailure).toHaveBeenCalledWith(
        "text",
        expect.any(Error),
        expect.objectContaining({ tripBreaker: false })
      );
      expect(mockLlmUsage.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "deep_search_understand_query",
          status: "failed",
        })
      );
    });

    it("aborts in-flight understanding when abortSignal triggers", async () => {
      mockAi.isInitialized.mockReturnValue(true);
      mockGenerateObject.mockImplementation(async ({ abortSignal }) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.aborted) {
          const error = new Error("AbortError");
          error.name = "AbortError";
          throw error;
        }
        return { object: { any: "raw" }, usage: {} };
      });

      const controller = new AbortController();
      const promise = service.understandQuery("test", 10_000, "UTC", controller.signal);
      // Ensure the abort listener is installed (DeepSearchService adds it after its first await).
      await Promise.resolve();
      controller.abort();
      const plan = await promise;
      expect(plan).toBeNull();
    });
  });

  describe("mergeFilters", () => {
    it("returns user filters when query plan confidence is low", () => {
      const user: SearchFilters = { timeRange: { start: 1, end: 2 }, entities: ["a"] };
      const queryPlan: SearchQueryPlan = {
        embeddingText: "x",
        confidence: 0.1,
        filtersPatch: { timeRange: { start: 10, end: 20 }, appHint: "vscode", entities: ["b"] },
      };
      const result = service.mergeFilters(user, queryPlan);
      expect(result).toEqual(user);
    });

    it("applies patch without overwriting existing fields", () => {
      const user: SearchFilters = {
        threadId: "t1",
        timeRange: { start: 1, end: 2 },
        entities: ["a"],
      };
      const queryPlan: SearchQueryPlan = {
        embeddingText: "x",
        confidence: 0.9,
        filtersPatch: {
          timeRange: { start: 10, end: 20 }, // should NOT overwrite existing timeRange
          appHint: "vscode",
          entities: ["a", "b"],
        },
      };
      const merged = service.mergeFilters(user, queryPlan);
      expect(merged.threadId).toBe("t1");
      expect(merged.timeRange).toEqual({ start: 1, end: 2 });
      expect(merged.appHint).toBe("vscode");
      expect(merged.entities?.sort()).toEqual(["a", "b"]);
    });
  });

  describe("synthesizeAnswer", () => {
    it("returns null when nodes are empty", async () => {
      mockAi.isInitialized.mockReturnValue(true);
      const result = await service.synthesizeAnswer("test", [], [], Date.now(), "UTC");
      expect(result).toBeNull();
      expect(mockGenerateObject).not.toHaveBeenCalled();
    });

    it("returns null when AI service is not initialized", async () => {
      const node = {
        id: 1,
        kind: "screenshot",
        title: "T",
        summary: "S",
        keywords: [],
        entities: [],
        eventTime: 1,
        screenshotIds: [1],
      } as unknown as ExpandedContextNode;
      const result = await service.synthesizeAnswer("test", [node], [], Date.now(), "UTC");
      expect(result).toBeNull();
      expect(mockGenerateObject).not.toHaveBeenCalled();
    });

    it("synthesizes answer on success", async () => {
      mockAi.isInitialized.mockReturnValue(true);
      mockGenerateObject.mockResolvedValueOnce({
        object: { any: "raw-answer" },
        usage: { totalTokens: 10 },
      });

      const nodes: ExpandedContextNode[] = [
        {
          kind: "screenshot",
          batchId: 1,
          title: "T",
          summary: "S".repeat(1000), // exercise truncation
          appContext: {
            appHint: "vscode",
            windowTitle: "w2",
            sourceKey: "screen:0",
            projectName: null,
            projectKey: null,
          },
          knowledge: null,
          stateSnapshot: null,
          uiTextSnippets: ["x"],
          keywords: ["k1", "k2"],
          entities: [{ name: "Entity", type: "other" }],
          importance: 7,
          confidence: 8,
          eventTime: 1000,
          screenshotIds: [1],
        },
      ];
      const evidence: ScreenshotEvidence[] = [
        {
          screenshotId: 999,
          timestamp: 500,
          appHint: "chrome",
          windowTitle: "w",
          uiTextSnippets: ["x"],
        },
        {
          screenshotId: 1,
          timestamp: 900,
          appHint: "vscode",
          windowTitle: "w2",
          uiTextSnippets: ["y"],
        },
      ];

      const answer = await service.synthesizeAnswer(
        "what is this?",
        nodes,
        evidence,
        10_000,
        "UTC"
      );
      expect(answer).toEqual(expect.objectContaining({ answer: "Test answer", confidence: 0.9 }));
      expect(mockAnswerParse).toHaveBeenCalledWith({ any: "raw-answer" });
      expect(mockPromptTemplates.getAnswerSynthesisUserPrompt).toHaveBeenCalled();
      expect(mockLlmUsage.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "deep_search_synthesize_answer",
          status: "succeeded",
        })
      );
    });
  });
});
