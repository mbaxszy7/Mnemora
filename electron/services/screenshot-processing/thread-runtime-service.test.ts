import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockEmit = vi.hoisted(() => vi.fn());
const mockOn = vi.hoisted(() => vi.fn(() => vi.fn()));

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("./event-bus", () => ({ screenshotProcessingEventBus: { emit: mockEmit, on: mockOn } }));
vi.mock("../../database", () => ({ getDb: mockGetDb }));
vi.mock("../../database/schema", () => ({
  threads: {
    id: "id",
    title: "title",
    summary: "summary",
    currentPhase: "currentPhase",
    currentFocus: "currentFocus",
    status: "status",
    startTime: "startTime",
    lastActiveAt: "lastActiveAt",
    durationMs: "durationMs",
    nodeCount: "nodeCount",
    apps: "apps",
    mainProject: "mainProject",
    keyEntities: "keyEntities",
    milestones: "milestones",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  userSetting: { id: "id", pinnedThreadId: "pinnedThreadId" },
  activitySummaries: {
    id: "id",
    status: "status",
    windowStart: "windowStart",
    windowEnd: "windowEnd",
    updatedAt: "updatedAt",
  },
  contextNodes: { id: "id", threadId: "threadId", eventTime: "eventTime" },
  activityEvents: { id: "id", threadId: "threadId", summaryId: "summaryId" },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) } }));
vi.mock("../ai-sdk-service", () => ({
  AISDKService: {
    getInstance: vi.fn(() => ({
      isInitialized: vi.fn(() => false),
      getTextClient: vi.fn(),
      getTextModelName: vi.fn(() => "m"),
    })),
  },
}));
vi.mock("./context-search-service", () => ({
  contextSearchService: { getThread: vi.fn().mockResolvedValue([]) },
}));
vi.mock("./threads-service", () => ({ threadsService: { getThreadById: vi.fn(() => null) } }));
vi.mock("./prompt-templates", () => ({
  promptTemplates: {
    getThreadBriefSystemPrompt: vi.fn(() => "s"),
    getThreadBriefUserPrompt: vi.fn(() => "u"),
  },
}));
vi.mock("./schemas", () => ({
  ThreadBriefLLMSchema: {},
  ThreadBriefLLMProcessedSchema: { parse: vi.fn((x) => x) },
  CANONICAL_APP_CANDIDATES: [],
}));
vi.mock("./config", () => ({ processingConfig: { ai: { textTimeoutMs: 1000 } } }));
vi.mock("../ai-runtime-service", () => ({
  aiRuntimeService: {
    acquire: vi.fn().mockResolvedValue(vi.fn()),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));
vi.mock("../llm-usage-service", () => ({
  llmUsageService: { logEvent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../monitoring/ai-request-trace", () => ({ aiRequestTraceBuffer: { record: vi.fn() } }));

import { ThreadRuntimeService } from "./thread-runtime-service";

describe("ThreadRuntimeService", () => {
  let service: ThreadRuntimeService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createDbMock({
      selectSteps: [{ get: { id: 1 } }, { get: { pinnedThreadId: null } }, { all: [] }],
    });
    mockGetDb.mockReturnValue(mockDb);
    service = new ThreadRuntimeService();
  });

  it("starts and stops with event subscriptions", () => {
    service.start();
    expect(mockOn).toHaveBeenCalledTimes(3);
    service.stop();
  });

  it("returns lens snapshot", async () => {
    const snapshot = await service.getLensStateSnapshot();
    expect(snapshot).toHaveProperty("revision");
    expect(snapshot).toHaveProperty("topThreads");
  });

  it("returns null for invalid brief thread id", async () => {
    expect(await service.getBrief({ threadId: "", force: false })).toBeNull();
    expect(await service.getBrief({ threadId: "  ", force: true })).toBeNull();
  });

  it("accepts refresh queue requests", () => {
    service.queueBriefRefresh({ threadId: "t1", type: "force" });
    service.queueBriefRefreshMany({ threadIds: ["t1", "t2"], type: "threshold" });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
