import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

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
  userSetting: {
    id: "id",
    pinnedThreadId: "pinnedThreadId",
    pinnedThreadUpdatedAt: "pinnedThreadUpdatedAt",
  },
}));
vi.mock("../user-setting-service", () => ({
  userSettingService: { getSettings: vi.fn().mockResolvedValue({}) },
}));
vi.mock("./config", () => ({
  processingConfig: { thread: { defaultLimit: 50, maxActiveThreads: 6, fallbackRecentThreads: 6 } },
}));

import { ThreadsService } from "./threads-service";

describe("ThreadsService", () => {
  let service: ThreadsService;

  const threadRow = {
    id: "t1",
    title: "T1",
    summary: "S1",
    currentPhase: null,
    currentFocus: null,
    status: "active",
    startTime: 10,
    lastActiveAt: 20,
    durationMs: 30,
    nodeCount: 2,
    apps: '["vscode"]',
    mainProject: null,
    keyEntities: "[]",
    milestones: null,
    createdAt: 1,
    updatedAt: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ThreadsService();
  });

  it("returns active thread state", async () => {
    mockDb = createDbMock({
      selectSteps: [
        { get: { id: 1 } },
        { get: { pinnedThreadId: "t1", pinnedThreadUpdatedAt: 100 } },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);
    const state = await service.getActiveThreadState();
    expect(state).toEqual({ pinnedThreadId: "t1", updatedAt: 100 });
  });

  it("pins and unpins thread", async () => {
    mockDb = createDbMock({
      selectSteps: [
        { get: { id: 1 } },
        { get: { id: 1 } },
        { get: { id: 1 } },
        { get: { pinnedThreadId: "t1", pinnedThreadUpdatedAt: 100 } },
        { get: { id: 1 } },
        { get: { id: 1 } },
        { get: { pinnedThreadId: null, pinnedThreadUpdatedAt: 200 } },
      ],
      updateSteps: [{ run: { changes: 1 } }, { run: { changes: 1 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const pinned = await service.pinThread("t1");
    expect(pinned.pinnedThreadId).toBe("t1");
    const unpinned = await service.unpinThread();
    expect(unpinned.pinnedThreadId).toBeNull();
  });

  it("returns null for invalid thread id", () => {
    expect(service.getThreadById("")).toBeNull();
    expect(service.getThreadById(" ")).toBeNull();
  });

  it("reads thread by id and lists threads", () => {
    mockDb = createDbMock({
      selectSteps: [{ get: threadRow }, { all: [threadRow] }],
    });
    mockGetDb.mockReturnValue(mockDb);
    expect(service.getThreadById("t1")?.id).toBe("t1");
    expect(service.listThreads(10).length).toBe(1);
  });

  it("returns active candidates", () => {
    mockDb = createDbMock({
      selectSteps: [{ all: [threadRow] }],
    });
    mockGetDb.mockReturnValue(mockDb);
    expect(service.getActiveThreadCandidates()[0]?.id).toBe("t1");
  });
});
