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

  it("getLatestActivityTimestamp prefers activity summary timestamp", async () => {
    mockDb = createDbMock({
      selectSteps: [{ get: { windowEnd: 200 } }, { get: { eventTime: 300 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.getLatestActivityTimestamp();
    expect(result).toEqual({ timestamp: 200, source: "activity_summaries" });
  });

  it("getLatestActivityTimestamp falls back to context node timestamp", async () => {
    mockDb = createDbMock({
      selectSteps: [{ get: undefined }, { get: { eventTime: 300 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.getLatestActivityTimestamp();
    expect(result).toEqual({ timestamp: 300, source: "context_nodes" });
  });

  it("getLatestActivityTimestamp returns null when no data", async () => {
    mockDb = createDbMock({ selectSteps: [{ get: undefined }, { get: undefined }] });
    mockGetDb.mockReturnValue(mockDb);

    const result = await service.getLatestActivityTimestamp();
    expect(result).toEqual({ timestamp: null, source: null });
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

  it("getSummary returns data when found", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              id: 1,
              windowStart: 0,
              windowEnd: 100,
              title: "W",
              status: "succeeded",
              summaryText: "Summary",
              highlights: "[]",
              stats: '{"nodeCount":1}',
            },
          ],
        },
        { all: [] },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);
    const summary = await service.getSummary(0, 100);
    expect(summary).toBeDefined();
    expect(summary?.title).toBe("W");
  });

  it("getEventDetails returns data when found", async () => {
    const eventRow = {
      id: 5,
      title: "E",
      kind: "work",
      startTs: 10,
      endTs: 20,
      durationMs: 10,
      isLong: true,
      confidence: 8,
      importance: 7,
      threadId: "t1",
      nodeIds: "[1]",
      detailsText: "Details",
      detailsStatus: "succeeded",
    };
    mockDb = createDbMock({ selectSteps: [{ all: [eventRow] }] });
    mockGetDb.mockReturnValue(mockDb);
    const details = await service.getEventDetails(5);
    expect(details.id).toBe(5);
    expect(details.details).toBe("Details");
  });

  it("generateEventDetails returns false when AI is not initialized", async () => {
    mockAi.isInitialized.mockReturnValue(false);
    const result = await service.generateEventDetails(1);
    expect(result).toBe(false);
  });

  it("generateEventDetails returns false when event is not long", async () => {
    mockAi.isInitialized.mockReturnValue(true);
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              id: 1,
              isLong: false,
              threadId: "t1",
              detailsStatus: "pending",
              detailsAttempts: 0,
              updatedAt: Date.now(),
            },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);
    const result = await service.generateEventDetails(1);
    expect(result).toBe(false);
  });

  it("generateEventDetails returns false when event has no threadId", async () => {
    mockAi.isInitialized.mockReturnValue(true);
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              id: 1,
              isLong: true,
              threadId: null,
              detailsStatus: "pending",
              detailsAttempts: 0,
              updatedAt: Date.now(),
            },
          ],
        },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);
    const result = await service.generateEventDetails(1);
    expect(result).toBe(false);
  });

  it("generateEventDetails returns false when max attempts exceeded", async () => {
    mockAi.isInitialized.mockReturnValue(true);
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              id: 1,
              isLong: true,
              threadId: "t1",
              detailsStatus: "pending",
              detailsAttempts: 3,
              updatedAt: Date.now(),
            },
          ],
        },
      ],
      updateSteps: [{ run: { changes: 1 } }],
    });
    mockGetDb.mockReturnValue(mockDb);
    const result = await service.generateEventDetails(1);
    expect(result).toBe(false);
  });

  it("upsertEvent inserts new event", async () => {
    mockDb = createDbMock({
      selectSteps: [{ all: [] }],
      insertSteps: [{ run: { lastInsertRowid: 42 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const id = await service.upsertEvent({
      eventKey: "key1",
      title: "Test",
      kind: "work",
      startTs: 1000,
      endTs: 2000,
    });
    expect(id).toBe(42);
  });

  it("upsertEvent updates existing event", async () => {
    mockDb = createDbMock({
      selectSteps: [
        {
          all: [
            {
              id: 10,
              eventKey: "key1",
              title: "Old",
              kind: "work",
              startTs: 1000,
              endTs: 2000,
              durationMs: 1000,
              isLong: false,
              confidence: 5,
              importance: 5,
              threadId: null,
              summaryId: null,
              nodeIds: "[1]",
            },
          ],
        },
      ],
      updateSteps: [{ run: { changes: 1 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const id = await service.upsertEvent({
      eventKey: "key1",
      title: "Updated",
      kind: "work",
      startTs: 500,
      endTs: 3000,
      nodeIds: [2, 3],
    });
    expect(id).toBe(10);
  });

  it("returns empty timeline for no data", async () => {
    mockDb = createDbMock({
      selectSteps: [{ all: [] }, { all: [] }],
    });
    mockGetDb.mockReturnValue(mockDb);
    const timeline = await service.getTimeline(0, 100);
    expect(timeline.windows).toEqual([]);
    expect(timeline.longEvents).toEqual([]);
  });
});
