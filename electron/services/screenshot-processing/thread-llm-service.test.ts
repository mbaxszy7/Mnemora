import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockNoObjectGeneratedError = vi.hoisted(() => ({
  isInstance: vi.fn(() => false),
}));

// Create a consistent mock for AISDKService
const createMockAISDKInstance = () => ({
  isInitialized: vi.fn(() => true),
  getTextClient: vi.fn(() => ({})),
  getTextModelName: vi.fn(() => "test-text-model"),
});

let mockAISDKInstance = createMockAISDKInstance();

const mockAISDKService = vi.hoisted(() => ({
  getInstance: vi.fn(() => mockAISDKInstance),
}));

const mockAiRuntimeService = vi.hoisted(() => ({
  acquire: vi.fn(() => Promise.resolve(vi.fn())),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));

const mockLlmUsageService = vi.hoisted(() => ({
  logEvent: vi.fn(),
}));

const mockAiRequestTraceBuffer = vi.hoisted(() => ({
  record: vi.fn(),
}));

const mockThreadsService = vi.hoisted(() => ({
  getActiveThreadCandidatesWithPinned: vi.fn(),
}));

const mockPromptTemplates = vi.hoisted(() => ({
  getThreadLlmSystemPrompt: vi.fn(() => "system prompt"),
  getThreadLlmUserPrompt: vi.fn(() => "user prompt"),
}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({
            all: vi.fn(() => []),
          })),
        })),
      })),
    })),
  })),
}));

// Mock modules
vi.mock("ai", () => ({
  generateObject: mockGenerateObject,
  NoObjectGeneratedError: mockNoObjectGeneratedError,
}));

vi.mock("../ai-sdk-service", () => ({
  AISDKService: mockAISDKService,
}));

vi.mock("../ai-runtime-service", () => ({
  aiRuntimeService: mockAiRuntimeService,
}));

vi.mock("../llm-usage-service", () => ({
  llmUsageService: mockLlmUsageService,
}));

vi.mock("../monitoring/ai-request-trace", () => ({
  aiRequestTraceBuffer: mockAiRequestTraceBuffer,
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./threads-service", () => ({
  threadsService: mockThreadsService,
}));

vi.mock("./prompt-templates", () => ({
  promptTemplates: mockPromptTemplates,
}));

vi.mock("./config", () => ({
  processingConfig: {
    ai: {
      textTimeoutMs: 120000,
    },
    thread: {
      recentNodesPerThread: 3,
    },
  },
}));

vi.mock("../../database", () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock("../../database/schema", () => ({
  contextNodes: {},
}));

import { ThreadLlmService } from "./thread-llm-service";

describe("ThreadLlmService", () => {
  let service: ThreadLlmService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAISDKInstance = createMockAISDKInstance();
    mockAISDKService.getInstance.mockReturnValue(mockAISDKInstance);
    service = new ThreadLlmService();
  });

  describe("assignForBatch", () => {
    const createMockBatchNodes = () => [
      {
        id: 1,
        title: "Node 1",
        summary: "Summary 1",
        eventTime: Date.now(),
        threadId: null,
        threadSnapshot: null,
        appContext: JSON.stringify({ appHint: "vscode", windowTitle: "test.ts" }),
        knowledge: null,
        stateSnapshot: null,
        keywords: JSON.stringify(["code", "test"]),
      },
    ];

    it("throws error when AI SDK is not initialized", async () => {
      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockAISDKInstance.isInitialized.mockReturnValue(false);

      await expect(
        service.assignForBatch({
          batchDbId: 1,
          batchNodes: createMockBatchNodes(),
        })
      ).rejects.toThrow("AI SDK not initialized");
    });

    it("successfully assigns threads to batch nodes", async () => {
      const mockOutput = {
        assignments: [{ node_index: 0, thread_id: "NEW", reason: "New thread" }],
        thread_updates: [],
        new_threads: [
          {
            title: "New Thread",
            summary: "Thread summary",
            node_indices: [0],
            milestones: ["Started"],
          },
        ],
      };

      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockResolvedValueOnce({
        object: mockOutput,
        usage: { totalTokens: 500 },
      });

      const result = await service.assignForBatch({
        batchDbId: 1,
        batchNodes: createMockBatchNodes(),
      });

      expect(result.output).toBeDefined();
      expect(result.output.assignments).toHaveLength(1);
      expect(result.activeThreadIds).toEqual([]);
      expect(mockAiRuntimeService.recordSuccess).toHaveBeenCalledWith("text");
    });

    it("logs usage event on success", async () => {
      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          assignments: [{ node_index: 0, thread_id: "thread-1", reason: "Existing" }],
          thread_updates: [],
          new_threads: [],
        },
        usage: { totalTokens: 300 },
      });

      await service.assignForBatch({
        batchDbId: 1,
        batchNodes: createMockBatchNodes(),
      });

      expect(mockLlmUsageService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "text",
          operation: "thread_assign",
          status: "succeeded",
          model: "test-text-model",
          totalTokens: 300,
        })
      );
    });

    it("handles NoObjectGeneratedError", async () => {
      const error = new Error("Schema validation failed");
      mockNoObjectGeneratedError.isInstance.mockReturnValueOnce(true);
      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockRejectedValueOnce(error);

      await expect(
        service.assignForBatch({
          batchDbId: 1,
          batchNodes: createMockBatchNodes(),
        })
      ).rejects.toThrow(error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorName: error.name,
        }),
        "Thread LLM NoObjectGeneratedError - raw response did not match schema"
      );
    });

    it("handles generic errors", async () => {
      const error = new Error("Network error");
      mockNoObjectGeneratedError.isInstance.mockReturnValueOnce(false);
      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockRejectedValueOnce(error);

      await expect(
        service.assignForBatch({
          batchDbId: 1,
          batchNodes: createMockBatchNodes(),
        })
      ).rejects.toThrow(error);

      expect(mockLogger.error).toHaveBeenCalledWith({ error }, "Thread LLM request failed");
    });

    it("records request trace on success", async () => {
      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          assignments: [{ node_index: 0, thread_id: "thread-1", reason: "Match" }],
          thread_updates: [],
          new_threads: [],
        },
        usage: {},
      });

      await service.assignForBatch({
        batchDbId: 1,
        batchNodes: createMockBatchNodes(),
      });

      expect(mockAiRequestTraceBuffer.record).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "text",
          operation: "thread_assign",
          model: "test-text-model",
          status: "succeeded",
        })
      );
    });

    it("records request trace on failure", async () => {
      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockRejectedValueOnce(new Error("API Error"));

      await expect(
        service.assignForBatch({
          batchDbId: 1,
          batchNodes: createMockBatchNodes(),
        })
      ).rejects.toThrow();

      expect(mockAiRequestTraceBuffer.record).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "text",
          operation: "thread_assign",
          model: "test-text-model",
          status: "failed",
        })
      );
    });

    it("includes active threads in prompt", async () => {
      const activeThreads = [
        {
          id: "thread-1",
          title: "Active Thread",
          summary: "Thread summary",
          currentPhase: "coding",
          currentFocus: null,
          status: "active",
          startTime: Date.now() - 3600000,
          lastActiveAt: Date.now(),
          durationMs: 3600000,
          nodeCount: 5,
          mainProject: "test-project",
        },
      ];

      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue(activeThreads);
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          assignments: [{ node_index: 0, thread_id: "thread-1", reason: "Match" }],
          thread_updates: [],
          new_threads: [],
        },
        usage: {},
      });

      await service.assignForBatch({
        batchDbId: 1,
        batchNodes: createMockBatchNodes(),
      });

      expect(mockPromptTemplates.getThreadLlmUserPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          activeThreadsJson: expect.stringContaining("thread-1"),
        })
      );
    });

    it("parses node JSON fields correctly", async () => {
      const batchNodes = [
        {
          id: 1,
          title: "Node 1",
          summary: "Summary 1",
          eventTime: Date.now(),
          threadId: null,
          threadSnapshot: null,
          appContext: JSON.stringify({
            appHint: "vscode",
            windowTitle: "test.ts",
            sourceKey: "screen:0",
            projectKey: "my-project",
          }),
          knowledge: JSON.stringify({
            contentType: "code",
            projectOrLibrary: "typescript",
          }),
          stateSnapshot: JSON.stringify({
            subject: "TestSubject",
            currentState: "active",
          }),
          keywords: JSON.stringify(["typescript", "testing"]),
        },
      ];

      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          assignments: [{ node_index: 0, thread_id: "NEW", reason: "New" }],
          thread_updates: [],
          new_threads: [
            {
              title: "New Thread",
              summary: "Summary",
              node_indices: [0],
              milestones: [],
            },
          ],
        },
        usage: {},
      });

      await service.assignForBatch({
        batchDbId: 1,
        batchNodes,
      });

      expect(mockPromptTemplates.getThreadLlmUserPrompt).toHaveBeenCalled();
      const callArgs = mockPromptTemplates.getThreadLlmUserPrompt.mock.calls[0][0];
      const batchNodesJson = JSON.parse(callArgs.batchNodesJson);

      expect(batchNodesJson[0].project_key).toBe("my-project");
      expect(batchNodesJson[0].keywords).toEqual(["typescript", "testing"]);
    });

    it("handles invalid JSON gracefully", async () => {
      const batchNodes = [
        {
          id: 1,
          title: "Node 1",
          summary: "Summary 1",
          eventTime: Date.now(),
          threadId: null,
          threadSnapshot: null,
          appContext: "invalid json",
          knowledge: null,
          stateSnapshot: null,
          keywords: JSON.stringify(["test"]),
        },
      ];

      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue([]);
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          assignments: [{ node_index: 0, thread_id: "NEW", reason: "New" }],
          thread_updates: [],
          new_threads: [
            {
              title: "New Thread",
              summary: "Summary",
              node_indices: [0],
              milestones: [],
            },
          ],
        },
        usage: {},
      });

      await service.assignForBatch({
        batchDbId: 1,
        batchNodes,
      });

      expect(mockPromptTemplates.getThreadLlmUserPrompt).toHaveBeenCalled();
    });

    it("loads recent nodes for active threads", async () => {
      const activeThreads = [
        {
          id: "thread-1",
          title: "Active Thread",
          summary: "Thread summary",
          currentPhase: "coding",
          currentFocus: null,
          status: "active",
          startTime: Date.now() - 3600000,
          lastActiveAt: Date.now(),
          durationMs: 3600000,
          nodeCount: 5,
          mainProject: "test-project",
        },
      ];

      const recentNodes = [
        {
          id: 1,
          title: "Recent Node",
          summary: "Recent summary",
          eventTime: Date.now() - 60000,
          threadId: "thread-1",
        },
      ];

      mockDb.select.mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                all: vi.fn(() => recentNodes),
              })),
            })),
          })),
        })),
      });

      mockThreadsService.getActiveThreadCandidatesWithPinned.mockResolvedValue(activeThreads);
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          assignments: [{ node_index: 0, thread_id: "thread-1", reason: "Match" }],
          thread_updates: [],
          new_threads: [],
        },
        usage: {},
      });

      await service.assignForBatch({
        batchDbId: 1,
        batchNodes: createMockBatchNodes(),
      });

      expect(mockPromptTemplates.getThreadLlmUserPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          threadRecentNodesJson: expect.stringContaining("Recent Node"),
        })
      );
    });
  });
});
