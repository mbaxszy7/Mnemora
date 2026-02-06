import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock } from "./test-utils/mock-db";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

let mockDb = createDbMock();
const mockGetDb = vi.hoisted(() => vi.fn(() => mockDb));

vi.mock("../logger", () => ({ getLogger: vi.fn(() => mockLogger) }));
vi.mock("../../database", () => ({ getDb: mockGetDb }));
vi.mock("../../database/schema", () => ({
  threads: {
    id: "id",
    originKey: "originKey",
    milestones: "milestones",
    status: "status",
    lastActiveAt: "lastActiveAt",
  },
  contextNodes: {
    id: "id",
    threadId: "threadId",
    threadSnapshot: "threadSnapshot",
    eventTime: "eventTime",
  },
  batches: { id: "id" },
  type: {},
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    and: vi.fn((...args: unknown[]) => args),
    asc: vi.fn(() => ({})),
    desc: vi.fn(() => ({})),
    eq: vi.fn(() => ({})),
    inArray: vi.fn(() => ({})),
    isNull: vi.fn(() => ({})),
    lt: vi.fn(() => ({})),
  };
});
vi.mock("./config", () => ({
  processingConfig: {
    thread: {
      gapThresholdMs: 600_000,
      inactiveThresholdMs: 4 * 60 * 60 * 1000,
    },
  },
}));

import { ThreadRepository, __test__ } from "./thread-repository";

describe("ThreadRepository", () => {
  let repository: ThreadRepository;

  const batchNodes = [
    {
      id: 1,
      eventTime: 1000,
      title: "n1",
      summary: "s1",
      threadId: null,
      threadSnapshot: null,
      appContext: JSON.stringify({ appHint: "vscode", projectKey: "p1" }),
      knowledge: null,
      stateSnapshot: null,
      keywords: JSON.stringify(["k1"]),
    },
    {
      id: 2,
      eventTime: 2000,
      title: "n2",
      summary: "s2",
      threadId: null,
      threadSnapshot: null,
      appContext: JSON.stringify({ appHint: "vscode", projectKey: "p1" }),
      knowledge: null,
      stateSnapshot: null,
      keywords: JSON.stringify(["k2"]),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mockDb = createDbMock();
    mockGetDb.mockReturnValue(mockDb);
    repository = new ThreadRepository();
  });

  it("validates assignment count", () => {
    expect(() =>
      repository.applyThreadLlmResult({
        batchDbId: 1,
        batchNodesAsc: batchNodes,
        output: { assignments: [], threadUpdates: [], newThreads: [] },
      })
    ).toThrow("assignments length");
  });

  it("throws when referenced existing thread does not exist", () => {
    mockDb = createDbMock({
      selectSteps: [{ all: [] }],
    });
    mockGetDb.mockReturnValue(mockDb);

    expect(() =>
      repository.applyThreadLlmResult({
        batchDbId: 1,
        batchNodesAsc: batchNodes,
        output: {
          assignments: [
            { nodeIndex: 0, threadId: "missing", reason: "x" },
            { nodeIndex: 1, threadId: "missing", reason: "x" },
          ],
          threadUpdates: [],
          newThreads: [],
        },
      })
    ).toThrow("Thread id does not exist");
  });

  it("applies thread result and returns affected ids", () => {
    mockDb = createDbMock({
      selectSteps: [
        { all: [{ id: "existing-1" }] },
        { all: [{ eventTime: 1000 }, { eventTime: 2000 }] },
        { all: [batchNodes[1], batchNodes[0]] },
        {
          get: {
            id: "existing-1",
            title: "T",
            summary: "S",
            durationMs: 1,
            startTime: 1,
            lastActiveAt: 2,
            currentPhase: null,
            currentFocus: null,
            mainProject: null,
          },
        },
      ],
      updateSteps: [
        { run: { changes: 1 } },
        { run: { changes: 1 } },
        { run: { changes: 1 } },
        { run: { changes: 1 } },
      ],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = repository.applyThreadLlmResult({
      batchDbId: 1,
      batchNodesAsc: batchNodes,
      output: {
        assignments: [
          { nodeIndex: 0, threadId: "existing-1", reason: "x" },
          { nodeIndex: 1, threadId: "existing-1", reason: "x" },
        ],
        threadUpdates: [],
        newThreads: [],
      },
    });

    expect(result.affectedThreadIds).toContain("existing-1");
    expect(result.assignedNodeIds).toEqual([1, 2]);
  });

  it("throws on duplicate assignment nodeIndex", () => {
    expect(() =>
      repository.applyThreadLlmResult({
        batchDbId: 1,
        batchNodesAsc: batchNodes,
        output: {
          assignments: [
            { nodeIndex: 0, threadId: "t1", reason: "x" },
            { nodeIndex: 0, threadId: "t1", reason: "x" },
          ],
          threadUpdates: [],
          newThreads: [],
        },
      })
    ).toThrow("Duplicate assignment");
  });

  it("throws on invalid nodeIndex", () => {
    expect(() =>
      repository.applyThreadLlmResult({
        batchDbId: 1,
        batchNodesAsc: batchNodes,
        output: {
          assignments: [
            { nodeIndex: 0, threadId: "t1", reason: "x" },
            { nodeIndex: 5, threadId: "t1", reason: "x" },
          ],
          threadUpdates: [],
          newThreads: [],
        },
      })
    ).toThrow("Invalid assignment nodeIndex");
  });

  it("throws when assignments contain NEW but new_threads is empty", () => {
    expect(() =>
      repository.applyThreadLlmResult({
        batchDbId: 1,
        batchNodesAsc: batchNodes,
        output: {
          assignments: [
            { nodeIndex: 0, threadId: "NEW", reason: "x" },
            { nodeIndex: 1, threadId: "t1", reason: "x" },
          ],
          threadUpdates: [],
          newThreads: [],
        },
      })
    ).toThrow("assignments contains NEW but new_threads is empty");
  });

  it("throws when missing assignment for a nodeIndex", () => {
    expect(() =>
      repository.applyThreadLlmResult({
        batchDbId: 1,
        batchNodesAsc: batchNodes,
        output: {
          assignments: [{ nodeIndex: 0, threadId: "t1", reason: "x" }],
          threadUpdates: [],
          newThreads: [],
        },
      })
    ).toThrow("assignments length");
  });

  it("finalizeBatchWithExistingAssignments works for pre-assigned nodes", () => {
    const assignedNodes = [
      { ...batchNodes[0], threadId: "t1" },
      { ...batchNodes[1], threadId: "t1" },
    ];
    mockDb = createDbMock({
      selectSteps: [
        { all: [{ eventTime: 1000 }, { eventTime: 2000 }] },
        { all: [assignedNodes[1], assignedNodes[0]] },
        {
          get: {
            id: "t1",
            title: "T",
            summary: "S",
            durationMs: 1,
            startTime: 1,
            lastActiveAt: 2,
            currentPhase: null,
            currentFocus: null,
            mainProject: null,
          },
        },
      ],
      updateSteps: [{ run: { changes: 1 } }, { run: { changes: 1 } }, { run: { changes: 1 } }],
    });
    mockGetDb.mockReturnValue(mockDb);

    const result = repository.finalizeBatchWithExistingAssignments({
      batchDbId: 1,
      batchNodesAsc: assignedNodes,
    });
    expect(result.affectedThreadIds).toContain("t1");
    expect(result.batchNodeIds).toEqual([1, 2]);
  });

  it("finalizeBatchWithExistingAssignments throws when no threads assigned", () => {
    expect(() =>
      repository.finalizeBatchWithExistingAssignments({
        batchDbId: 1,
        batchNodesAsc: batchNodes,
      })
    ).toThrow("Cannot finalize batch: no assigned threads");
  });

  it("marks inactive threads", () => {
    mockDb = createDbMock({ updateSteps: [{ run: { changes: 3 } }] });
    mockGetDb.mockReturnValue(mockDb);
    expect(repository.markInactiveThreads()).toBe(3);
  });

  describe("computeDurationMs", () => {
    it("computes duration with threshold gaps", () => {
      expect(__test__.computeDurationMs([0, 1_000, 10_000], 2_000)).toBe(1_000);
    });

    it("returns 0 for empty array", () => {
      expect(__test__.computeDurationMs([], 2_000)).toBe(0);
    });

    it("returns 0 for single element", () => {
      expect(__test__.computeDurationMs([100], 2_000)).toBe(0);
    });

    it("sums all deltas when within threshold", () => {
      expect(__test__.computeDurationMs([0, 100, 200, 300], 500)).toBe(300);
    });

    it("excludes all gaps exceeding threshold", () => {
      expect(__test__.computeDurationMs([0, 5000, 10000], 1000)).toBe(0);
    });

    it("mixes valid and invalid gaps", () => {
      expect(__test__.computeDurationMs([0, 500, 5000, 5500], 1000)).toBe(1000);
    });
  });
});
