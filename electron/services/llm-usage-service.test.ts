import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLoadConfiguration = vi.hoisted(() => vi.fn(async () => null));
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

let mockDb = createDbMock({
  insertSteps: [{ run: undefined }],
  selectSteps: [{ get: null }],
});
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../database", () => ({
  getDb: mockGetDb,
}));

vi.mock("../database/schema", () => ({
  llmUsageEvents: {
    ts: "ts",
    totalTokens: "totalTokens",
    status: "status",
    configHash: "configHash",
    model: "model",
    capability: "capability",
  },
}));

vi.mock("./llm-config-service", () => ({
  llmConfigService: {
    loadConfiguration: mockLoadConfiguration,
  },
}));

vi.mock("./logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

import { LLMUsageService } from "./llm-usage-service";

describe("LLMUsageService", () => {
  let service: LLMUsageService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createDbMock({
      insertSteps: [{ run: undefined }],
      selectSteps: [{ get: null }, { all: [] }, { all: [] }],
    });
    mockGetDb.mockReturnValue(mockDb);
    service = LLMUsageService.getInstance();
  });

  it("returns unconfigured hash when config is absent", async () => {
    mockLoadConfiguration.mockResolvedValueOnce(null);
    await expect(service.getConfigHash()).resolves.toBe("unconfigured");
  });

  it("logs events with resolved config hash", async () => {
    mockLoadConfiguration.mockResolvedValueOnce({
      mode: "unified",
      config: { baseUrl: "http://x", model: "m1" },
    });

    await service.logEvent({
      ts: Date.now(),
      capability: "text",
      provider: "x",
      model: "m1",
      status: "succeeded",
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      requestId: "r1",
      errorType: null,
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it("returns zero-default summary when query result is empty", async () => {
    const result = await service.getUsageSummary({ fromTs: 1, toTs: 2 });
    expect(result).toEqual({
      totalTokens: 0,
      requestCount: 0,
      succeededCount: 0,
      failedCount: 0,
    });
  });
});
