import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockEmit = vi.hoisted(() => vi.fn());
const mockAi = vi.hoisted(() => ({
  isInitialized: vi.fn(() => false),
  getTextClient: vi.fn(),
  getTextModelName: vi.fn(() => "test-model"),
}));

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("./event-bus", () => ({ screenshotProcessingEventBus: { emit: mockEmit } }));
vi.mock("../../database", () => ({ getDb: mockGetDb }));
vi.mock("../../database/schema", () => ({
  activitySummaries: {
    id: "id",
    windowStart: "windowStart",
    windowEnd: "windowEnd",
    status: "status",
    title: "title",
    summaryText: "summaryText",
    highlights: "highlights",
    stats: "stats",
    updatedAt: "updatedAt",
    nextRunAt: "nextRunAt",
  },
  activityEvents: {
    id: "id",
    eventKey: "eventKey",
    title: "title",
    kind: "kind",
    startTs: "startTs",
    endTs: "endTs",
    durationMs: "durationMs",
    isLong: "isLong",
    confidence: "confidence",
    importance: "importance",
    threadId: "threadId",
    nodeIds: "nodeIds",
    detailsText: "detailsText",
    detailsStatus: "detailsStatus",
    summaryId: "summaryId",
    detailsAttempts: "detailsAttempts",
    updatedAt: "updatedAt",
  },
  contextNodes: { id: "id", eventTime: "eventTime", threadId: "threadId" },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) } }));
vi.mock("../ai-sdk-service", () => ({ AISDKService: { getInstance: vi.fn(() => mockAi) } }));
vi.mock("../llm-usage-service", () => ({
  llmUsageService: { logEvent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../ai-runtime-service", () => ({
  aiRuntimeService: {
    acquire: vi.fn().mockResolvedValue(vi.fn()),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));
vi.mock("../monitoring/ai-request-trace", () => ({ aiRequestTraceBuffer: { record: vi.fn() } }));
vi.mock("../monitoring/activity-alert-trace", () => ({ activityAlertBuffer: { record: vi.fn() } }));
vi.mock("./prompt-templates", () => ({
  promptTemplates: {
    getActivitySummarySystemPrompt: vi.fn(() => "system"),
    getActivitySummaryUserPrompt: vi.fn(() => "user"),
    getEventDetailsSystemPrompt: vi.fn(() => "system"),
    getEventDetailsUserPrompt: vi.fn(() => "user"),
  },
}));
vi.mock("./schemas", () => ({
  ActivityWindowSummaryLLMSchema: {},
  ActivityWindowSummaryLLMProcessedSchema: { parse: vi.fn((x) => x) },
  ActivityEventDetailsLLMSchema: {},
  ActivityEventDetailsLLMProcessedSchema: { parse: vi.fn((x) => x) },
}));
vi.mock("./config", () => ({
  processingConfig: {
    ai: { textTimeoutMs: 1000 },
    activitySummary: {
      longEventThresholdMs: 600_000,
      eventDetailsEvidenceMaxNodes: 20,
      eventDetailsEvidenceMaxChars: 20_000,
    },
    scheduler: { staleRunningThresholdMs: 10_000 },
    retry: { maxAttempts: 3 },
  },
}));

import { ActivityMonitorService } from "./activity-monitor-service";

describe("ActivityMonitorService", () => {
  let service: ActivityMonitorService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ActivityMonitorService();
  });

  it("returns timeline windows and long events", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            { id: 1, windowStart: 0, windowEnd: 100, title: "W", status: "succeeded", stats: null },
          ],
        },
        { all: [{ id: 9, title: "E", kind: "work", startTs: 1, endTs: 2, durationMs: 1 }] },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const timeline = await service.getTimeline(0, 100);
    expect(timeline.windows.length).toBe(1);
    expect(timeline.longEvents.length).toBe(1);
  });

  it("returns null summary when not found", async () => {
    mockDb = createDbMock({ selectSteps: [{ all: [] }] });
    mockGetDb.mockReturnValue(mockDb);
    expect(await service.getSummary(0, 100)).toBeNull();
  });

  it("regenerateSummary returns not_found / not_failed_permanent / not_initialized", async () => {
    mockDb = createDbMock({ selectSteps: [{ get: undefined }] });
    mockGetDb.mockReturnValue(mockDb);
    expect(await service.regenerateSummary(0, 1)).toEqual({ ok: false, reason: "not_found" });

    mockDb = createDbMock({ selectSteps: [{ get: { status: "succeeded" } }] });
    mockGetDb.mockReturnValue(mockDb);
    expect(await service.regenerateSummary(0, 1)).toEqual({
      ok: false,
      reason: "not_failed_permanent",
    });

    mockDb = createDbMock({ selectSteps: [{ get: { status: "failed_permanent" } }] });
    mockGetDb.mockReturnValue(mockDb);
    mockAi.isInitialized.mockReturnValue(false);
    expect(await service.regenerateSummary(0, 1)).toEqual({ ok: false, reason: "not_initialized" });
  });

  it("throws when event id does not exist", async () => {
    mockDb = createDbMock({ selectSteps: [{ all: [] }] });
    mockGetDb.mockReturnValue(mockDb);
    await expect(service.getEventDetails(123)).rejects.toThrow("Event not found: 123");
  });

  it("returns false when AI is not initialized", async () => {
    mockAi.isInitialized.mockReturnValue(false);
    expect(await service.generateWindowSummary(0, 100)).toBe(false);
  });
});
