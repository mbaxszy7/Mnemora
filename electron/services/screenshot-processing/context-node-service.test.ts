import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

// Mock modules
vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("../../database", () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock("../../database/schema", () => ({
  contextNodes: {},
  contextScreenshotLinks: {},
}));

import { ContextNodeService } from "./context-node-service";
import type { UpsertNodeInput } from "./types";

describe("ContextNodeService", () => {
  let service: ContextNodeService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ContextNodeService();
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("upsertNodeForScreenshot", () => {
    const createMockInput = (): UpsertNodeInput => ({
      batchId: 100,
      screenshotId: 1,
      screenshotTs: Date.now(),
      title: "Test Title",
      summary: "Test Summary",
      appContext: {
        appHint: "vscode",
        windowTitle: "test.ts",
        sourceKey: "screen:0",
      },
      knowledge: {
        contentType: "code",
        keyInsights: ["insight1"],
        language: "en",
      },
      stateSnapshot: {
        subjectType: "file",
        subject: "test.ts",
        currentState: "editing",
      },
      actionItems: [{ action: "review code", priority: "high", source: "explicit" }],
      uiTextSnippets: ["snippet1", "snippet2"],
      keywords: ["typescript", "test"],
      entities: [{ name: "TestEntity", type: "other" }],
      importance: 5,
      confidence: 8,
    });

    it("creates new context node for new screenshot", async () => {
      const input = createMockInput();

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce(null), // No existing link
          })),
        })),
      });

      mockDb.insert
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            returning: vi.fn(() => ({
              get: vi.fn(() => ({ id: 42 })),
            })),
          })),
        })
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              run: vi.fn(),
            })),
          })),
        });

      const result = await service.upsertNodeForScreenshot(input);

      expect(result).toBe(42);
      expect(mockDb.insert).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { nodeId: 42, screenshotId: 1 },
        "Upserted context node"
      );
    });

    it("updates existing context node for existing screenshot", async () => {
      const input = createMockInput();

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce({ nodeId: 42 }),
          })),
        })),
      });

      mockDb.update.mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            run: vi.fn(() => ({ changes: 1 })),
          })),
        })),
      });

      const result = await service.upsertNodeForScreenshot(input);

      expect(result).toBe(42);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("throws error when insert fails", async () => {
      const input = createMockInput();

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce(null),
          })),
        })),
      });

      mockDb.insert.mockReturnValueOnce({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce(null),
          })),
        })),
      });

      await expect(service.upsertNodeForScreenshot(input)).rejects.toThrow(
        "Failed to insert context node"
      );
    });

    it("correctly serializes JSON fields", async () => {
      const input = createMockInput();

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce(null),
          })),
        })),
      });

      let capturedValues: Record<string, unknown> = {};
      mockDb.insert
        .mockReturnValueOnce({
          values: vi.fn((values) => {
            capturedValues = values;
            return {
              returning: vi.fn(() => ({
                get: vi.fn(() => ({ id: 42 })),
              })),
            };
          }),
        })
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              run: vi.fn(),
            })),
          })),
        });

      await service.upsertNodeForScreenshot(input);

      expect(capturedValues.appContext).toBe(JSON.stringify(input.appContext));
      expect(capturedValues.knowledge).toBe(JSON.stringify(input.knowledge));
      expect(capturedValues.stateSnapshot).toBe(JSON.stringify(input.stateSnapshot));
      expect(capturedValues.actionItems).toBe(JSON.stringify(input.actionItems));
      expect(capturedValues.uiTextSnippets).toBe(JSON.stringify(input.uiTextSnippets));
      expect(capturedValues.keywords).toBe(JSON.stringify(input.keywords));
      expect(capturedValues.entities).toBe(JSON.stringify(input.entities));
    });

    it("handles null optional fields", async () => {
      const input: UpsertNodeInput = {
        batchId: 100,
        screenshotId: 1,
        screenshotTs: Date.now(),
        title: "Test",
        summary: "Summary",
        appContext: { sourceKey: "screen:0" },
        knowledge: null,
        stateSnapshot: null,
        actionItems: null,
        uiTextSnippets: [],
        keywords: [],
        entities: [],
        importance: 5,
        confidence: 8,
      };

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce(null),
          })),
        })),
      });

      let capturedValues: Record<string, unknown> = {};
      mockDb.insert
        .mockReturnValueOnce({
          values: vi.fn((values) => {
            capturedValues = values;
            return {
              returning: vi.fn(() => ({
                get: vi.fn(() => ({ id: 42 })),
              })),
            };
          }),
        })
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              run: vi.fn(),
            })),
          })),
        });

      await service.upsertNodeForScreenshot(input);

      expect(capturedValues.knowledge).toBeNull();
      expect(capturedValues.stateSnapshot).toBeNull();
      expect(capturedValues.actionItems).toBeNull();
    });

    it("sets correct timestamps", async () => {
      const now = 1000000;
      vi.setSystemTime(now);

      const input = createMockInput();

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce(null),
          })),
        })),
      });

      let capturedValues: Record<string, unknown> = {};
      mockDb.insert
        .mockReturnValueOnce({
          values: vi.fn((values) => {
            capturedValues = values;
            return {
              returning: vi.fn(() => ({
                get: vi.fn(() => ({ id: 42 })),
              })),
            };
          }),
        })
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              run: vi.fn(),
            })),
          })),
        });

      await service.upsertNodeForScreenshot(input);

      expect(capturedValues.createdAt).toBe(now);
      expect(capturedValues.updatedAt).toBe(now);
      expect(capturedValues.eventTime).toBe(input.screenshotTs);
    });

    it("updates all fields when node exists", async () => {
      const input = createMockInput();

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce({ nodeId: 42 }),
          })),
        })),
      });

      let capturedPatch: Record<string, unknown> = {};
      mockDb.update.mockReturnValue({
        set: vi.fn((patch) => {
          capturedPatch = patch;
          return {
            where: vi.fn(() => ({
              run: vi.fn(() => ({ changes: 1 })),
            })),
          };
        }),
      });

      await service.upsertNodeForScreenshot(input);

      expect(capturedPatch.title).toBe(input.title);
      expect(capturedPatch.summary).toBe(input.summary);
      expect(capturedPatch.appContext).toBe(JSON.stringify(input.appContext));
      expect(capturedPatch.knowledge).toBe(JSON.stringify(input.knowledge));
      expect(capturedPatch.stateSnapshot).toBe(JSON.stringify(input.stateSnapshot));
      expect(capturedPatch.actionItems).toBe(JSON.stringify(input.actionItems));
      expect(capturedPatch.uiTextSnippets).toBe(JSON.stringify(input.uiTextSnippets));
      expect(capturedPatch.importance).toBe(input.importance);
      expect(capturedPatch.confidence).toBe(input.confidence);
      expect(capturedPatch.keywords).toBe(JSON.stringify(input.keywords));
      expect(capturedPatch.entities).toBe(JSON.stringify(input.entities));
    });

    it("creates screenshot link with conflict handling", async () => {
      const input = createMockInput();

      mockDb.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn().mockReturnValueOnce(null),
          })),
        })),
      });

      const mockLinkRun = vi.fn();
      mockDb.insert
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            returning: vi.fn(() => ({
              get: vi.fn(() => ({ id: 42 })),
            })),
          })),
        })
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              run: mockLinkRun,
            })),
          })),
        });

      await service.upsertNodeForScreenshot(input);

      expect(mockLinkRun).toHaveBeenCalled();
    });
  });
});
