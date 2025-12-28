/**
 * Text LLM Processor Tests
 *
 * Tests for the TextLLMProcessor class covering:
 * - Segment to node expansion
 * - Merge hint processing (NEW vs MERGE)
 * - Node merging with evidence preservation
 * - Evidence enrichment
 * - Integration with ContextGraphService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { TextLLMProcessor } from "./text-llm-processor";
import type { VLMIndexResult, VLMSegment } from "./schemas";
import type {
  Batch,
  AcceptedScreenshot,
  EvidencePack,
  ExpandedContextNode,
  SourceKey,
} from "./types";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock screenshot
 */
function createMockScreenshot(
  id: number,
  ts: number,
  sourceKey: SourceKey = "screen:1"
): AcceptedScreenshot {
  return {
    id,
    ts,
    sourceKey,
    phash: `hash_${id}`,
    filePath: `/path/to/screenshot_${id}.png`,
    meta: {
      appHint: "TestApp",
      windowTitle: "Test Window",
      width: 1920,
      height: 1080,
      bytes: 100000,
      mime: "image/png",
    },
  };
}

/**
 * Create a mock batch
 */
function createMockBatch(screenshotCount: number = 5): Batch {
  const now = Date.now();
  const screenshots: AcceptedScreenshot[] = [];

  for (let i = 0; i < screenshotCount; i++) {
    screenshots.push(createMockScreenshot(i + 1, now + i * 6000));
  }

  return {
    batchId: `batch_${now}`,
    sourceKey: "screen:1",
    screenshots,
    status: "pending",
    idempotencyKey: `vlm_batch:screen:1:${now}-${now + screenshotCount * 6000}:abc123`,
    tsStart: screenshots[0].ts,
    tsEnd: screenshots[screenshots.length - 1].ts,
    historyPack: {
      recentThreads: [],
      openSegments: [],
      recentEntities: [],
    },
  };
}

/**
 * Create a mock VLM segment
 */
function createMockSegment(
  segmentId: string,
  screenIds: number[],
  decision: "NEW" | "MERGE" = "NEW",
  threadId?: string
): VLMSegment {
  return {
    segment_id: segmentId,
    screen_ids: screenIds,
    event: {
      title: `current_user working on ${segmentId}`,
      summary: `current_user is performing task related to ${segmentId}`,
      confidence: 8,
      importance: 7,
    },
    derived: {
      knowledge: [
        {
          title: "Knowledge from segment",
          summary: "Some reusable knowledge extracted from the activity",
        },
      ],
      state: [],
      procedure: [],
      plan: [],
    },
    merge_hint: {
      decision,
      thread_id: threadId,
    },
    keywords: ["test", "activity", segmentId],
  };
}

/**
 * Create a mock VLM Index result
 */
function createMockVLMIndex(segments: VLMSegment[]): VLMIndexResult {
  return {
    segments,
    entities: ["TestProject", "John Doe", "JIRA-123"],
    screenshots: [
      {
        screenshot_id: 1,
        ocr_text: "Some OCR text from screenshot 1",
        ui_text_snippets: ["Important message", "Key decision"],
      },
      {
        screenshot_id: 2,
        ocr_text: "Some OCR text from screenshot 2",
        ui_text_snippets: ["Another snippet"],
      },
    ],
    notes: "Test notes",
  };
}

// ============================================================================
// Mock ContextGraphService
// ============================================================================

// Track created nodes for verification
let createdNodes: Array<{
  kind: string;
  threadId?: string;
  title: string;
  sourceEventId?: number;
  screenshotIds?: number[];
}> = [];

let nodeIdCounter = 1;

vi.mock("./context-graph-service", () => {
  return {
    contextGraphService: {
      createNode: vi.fn().mockImplementation((input) => {
        const nodeId = String(nodeIdCounter++);
        createdNodes.push({
          kind: input.kind,
          threadId: input.threadId,
          title: input.title,
          sourceEventId: input.sourceEventId,
          screenshotIds: input.screenshotIds,
        });
        return Promise.resolve(nodeId);
      }),
      createEdge: vi.fn().mockResolvedValue(undefined),
      linkScreenshot: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// ============================================================================
// Tests
// ============================================================================

describe("TextLLMProcessor", () => {
  let processor: TextLLMProcessor;

  beforeEach(() => {
    processor = new TextLLMProcessor();
    createdNodes = []; // Clear tracked nodes
    nodeIdCounter = 1; // Reset counter
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("expandToNodes", () => {
    it("should generate at least one event node per segment", async () => {
      const batch = createMockBatch(5);
      const segments = [createMockSegment("seg_1", [1, 2, 3]), createMockSegment("seg_2", [4, 5])];
      const vlmIndex = createMockVLMIndex(segments);

      const result = await processor.expandToNodes(vlmIndex, batch);

      expect(result.success).toBe(true);
      expect(result.nodeIds.length).toBeGreaterThanOrEqual(2);

      // Verify event nodes were created
      const eventNodes = createdNodes.filter((n) => n.kind === "event");
      expect(eventNodes.length).toBe(2);
    });

    it("should create derived nodes for knowledge/state/procedure/plan", async () => {
      const batch = createMockBatch(3);
      const segment: VLMSegment = {
        segment_id: "seg_1",
        screen_ids: [1, 2, 3],
        event: {
          title: "current_user reviewing code",
          summary: "current_user is reviewing pull request",
          confidence: 8,
          importance: 7,
        },
        derived: {
          knowledge: [{ title: "Code pattern", summary: "Singleton pattern usage" }],
          state: [{ title: "PR status", summary: "PR is pending review", object: "PR #123" }],
          procedure: [
            { title: "Review process", summary: "Code review steps", steps: ["Read", "Comment"] },
          ],
          plan: [{ title: "Next steps", summary: "Merge after approval" }],
        },
        merge_hint: { decision: "NEW" },
        keywords: ["code", "review"],
      };
      const vlmIndex = createMockVLMIndex([segment]);

      const result = await processor.expandToNodes(vlmIndex, batch);

      expect(result.success).toBe(true);

      // Should have 1 event + 4 derived nodes
      expect(createdNodes.length).toBe(5);

      const kinds = createdNodes.map((n) => n.kind);
      expect(kinds).toContain("event");
      expect(kinds).toContain("knowledge");
      expect(kinds).toContain("state_snapshot");
      expect(kinds).toContain("procedure");
      expect(kinds).toContain("plan");
    });

    it("should handle merge_hint.decision=NEW by creating new thread", async () => {
      const batch = createMockBatch(3);
      const segment = createMockSegment("seg_1", [1, 2, 3], "NEW");
      const vlmIndex = createMockVLMIndex([segment]);

      const result = await processor.expandToNodes(vlmIndex, batch);

      expect(result.success).toBe(true);
      expect(result.threadIds.length).toBe(1);

      // Thread ID should be newly generated
      const eventNode = createdNodes.find((n) => n.kind === "event");
      expect(eventNode?.threadId).toBeDefined();
      expect(eventNode?.threadId).toMatch(/^thread_\d+_[a-f0-9]+$/);
    });

    it("should handle merge_hint.decision=MERGE by using existing thread_id", async () => {
      const existingThreadId = "thread_existing_123";
      const batch = createMockBatch(3);
      const segment = createMockSegment("seg_1", [1, 2, 3], "MERGE", existingThreadId);
      const vlmIndex = createMockVLMIndex([segment]);

      const result = await processor.expandToNodes(vlmIndex, batch);

      expect(result.success).toBe(true);
      expect(result.threadIds).toContain(existingThreadId);

      // Event node should use the existing thread ID
      const eventNode = createdNodes.find((n) => n.kind === "event");
      expect(eventNode?.threadId).toBe(existingThreadId);
    });

    it("should pass sourceEventId for derived nodes (CP-8)", async () => {
      const batch = createMockBatch(3);
      const segment: VLMSegment = {
        segment_id: "seg_1",
        screen_ids: [1, 2, 3],
        event: {
          title: "current_user working",
          summary: "current_user is working on task",
          confidence: 8,
          importance: 7,
        },
        derived: {
          knowledge: [{ title: "Knowledge item", summary: "Some knowledge" }],
          state: [],
          procedure: [],
          plan: [],
        },
        merge_hint: { decision: "NEW" },
        keywords: [],
      };
      const vlmIndex = createMockVLMIndex([segment]);

      await processor.expandToNodes(vlmIndex, batch);

      // Find the knowledge node
      const knowledgeNode = createdNodes.find((n) => n.kind === "knowledge");
      expect(knowledgeNode).toBeDefined();

      // It should have sourceEventId pointing to the event node (ID "1")
      expect(knowledgeNode?.sourceEventId).toBe(1);
    });

    it("should link screenshots to nodes", async () => {
      const batch = createMockBatch(5);
      const segment = createMockSegment("seg_1", [1, 2, 3]);
      const vlmIndex = createMockVLMIndex([segment]);

      await processor.expandToNodes(vlmIndex, batch);

      // Event node should have screenshot IDs
      const eventNode = createdNodes.find((n) => n.kind === "event");
      expect(eventNode?.screenshotIds).toEqual([1, 2, 3]);
    });

    it("should handle empty segments gracefully", async () => {
      const batch = createMockBatch(3);
      const vlmIndex: VLMIndexResult = {
        segments: [],
        entities: [],
        screenshots: [],
      };

      const result = await processor.expandToNodes(vlmIndex, batch);

      expect(result.success).toBe(true);
      expect(result.nodeIds.length).toBe(0);
      expect(result.threadIds.length).toBe(0);
    });
  });

  describe("executeMerge", () => {
    it("should preserve merged_from_ids when merging nodes", async () => {
      const existingNode: ExpandedContextNode = {
        kind: "event",
        threadId: "thread_1",
        title: "Existing event",
        summary: "Existing summary",
        keywords: ["existing", "keyword"],
        entities: [{ name: "Entity1" }],
        importance: 7,
        confidence: 8,
        mergedFromIds: [100, 101],
        screenshotIds: [1, 2],
        eventTime: 1000000,
      };

      const newNode: ExpandedContextNode = {
        kind: "event",
        threadId: "thread_1",
        title: "New event",
        summary: "New summary that is longer than existing",
        keywords: ["new", "keyword"],
        entities: [{ name: "Entity2" }],
        importance: 8,
        confidence: 7,
        mergedFromIds: [102],
        screenshotIds: [3, 4],
        eventTime: 2000000,
      };

      const result = await processor.executeMerge(newNode, existingNode);

      // Should preserve all merged_from_ids
      expect(result.mergedFromIds).toEqual([100, 101, 102]);
      expect(result.mergedNode.mergedFromIds).toEqual([100, 101, 102]);
    });

    it("should keep all screenshot links when merging", async () => {
      const existingNode: ExpandedContextNode = {
        kind: "event",
        threadId: "thread_1",
        title: "Existing",
        summary: "Summary",
        keywords: [],
        entities: [],
        importance: 5,
        confidence: 5,
        screenshotIds: [1, 2, 3],
      };

      const newNode: ExpandedContextNode = {
        kind: "event",
        threadId: "thread_1",
        title: "New",
        summary: "Summary",
        keywords: [],
        entities: [],
        importance: 5,
        confidence: 5,
        screenshotIds: [3, 4, 5],
      };

      const result = await processor.executeMerge(newNode, existingNode);

      // Should combine screenshot IDs (unique)
      expect(result.mergedNode.screenshotIds).toEqual([1, 2, 3, 4, 5]);
    });

    it("should combine keywords and entities uniquely", async () => {
      const existingNode: ExpandedContextNode = {
        kind: "knowledge",
        title: "Knowledge",
        summary: "Summary",
        keywords: ["a", "b", "c"],
        entities: [{ name: "Entity1" }, { name: "Entity2" }],
        importance: 5,
        confidence: 5,
        screenshotIds: [],
      };

      const newNode: ExpandedContextNode = {
        kind: "knowledge",
        title: "Knowledge",
        summary: "Summary",
        keywords: ["b", "c", "d"],
        entities: [{ name: "Entity2" }, { name: "Entity3" }],
        importance: 5,
        confidence: 5,
        screenshotIds: [],
      };

      const result = await processor.executeMerge(newNode, existingNode);

      // Keywords should be unique
      expect(result.mergedNode.keywords).toEqual(["a", "b", "c", "d"]);

      // Entities should be unique by name
      const entityNames = result.mergedNode.entities.map((e) => e.name);
      expect(entityNames).toEqual(["Entity1", "Entity2", "Entity3"]);
    });

    it("should use higher importance and confidence values", async () => {
      const existingNode: ExpandedContextNode = {
        kind: "event",
        title: "Event",
        summary: "Summary",
        keywords: [],
        entities: [],
        importance: 6,
        confidence: 7,
        screenshotIds: [],
      };

      const newNode: ExpandedContextNode = {
        kind: "event",
        title: "Event",
        summary: "Summary",
        keywords: [],
        entities: [],
        importance: 8,
        confidence: 5,
        screenshotIds: [],
      };

      const result = await processor.executeMerge(newNode, existingNode);

      expect(result.mergedNode.importance).toBe(8);
      expect(result.mergedNode.confidence).toBe(7);
    });
  });

  describe("buildExpandPrompt", () => {
    it("should include VLM segments in prompt", () => {
      const batch = createMockBatch(3);
      const segment = createMockSegment("seg_1", [1, 2, 3]);
      const vlmIndex = createMockVLMIndex([segment]);
      const evidencePacks: EvidencePack[] = [
        { screenshotId: 1, appHint: "TestApp", ocrText: "OCR text" },
      ];

      const prompt = processor.buildExpandPrompt(vlmIndex, batch, evidencePacks);

      expect(prompt).toContain("seg_1");
      expect(prompt).toContain("VLM Segments");
    });

    it("should include screenshot mapping in prompt", () => {
      const batch = createMockBatch(3);
      const vlmIndex = createMockVLMIndex([createMockSegment("seg_1", [1, 2, 3])]);
      const evidencePacks: EvidencePack[] = [];

      const prompt = processor.buildExpandPrompt(vlmIndex, batch, evidencePacks);

      expect(prompt).toContain("Screenshot Mapping");
      expect(prompt).toContain("screen_id");
      expect(prompt).toContain("database_id");
    });

    it("should include evidence packs in prompt", () => {
      const batch = createMockBatch(3);
      const vlmIndex = createMockVLMIndex([createMockSegment("seg_1", [1, 2, 3])]);
      const evidencePacks: EvidencePack[] = [
        {
          screenshotId: 1,
          appHint: "VSCode",
          windowTitle: "main.ts",
          ocrText: "function test() {}",
          uiTextSnippets: ["Important code"],
        },
      ];

      const prompt = processor.buildExpandPrompt(vlmIndex, batch, evidencePacks);

      expect(prompt).toContain("Evidence Packs");
      expect(prompt).toContain("VSCode");
      expect(prompt).toContain("main.ts");
    });

    it("should include batch info in prompt", () => {
      const batch = createMockBatch(3);
      const vlmIndex = createMockVLMIndex([createMockSegment("seg_1", [1, 2, 3])]);

      const prompt = processor.buildExpandPrompt(vlmIndex, batch, []);

      expect(prompt).toContain("Batch Info");
      expect(prompt).toContain(batch.batchId);
      expect(prompt).toContain(batch.sourceKey);
    });
  });

  describe("cross-thread knowledge merge", () => {
    it("should support knowledge nodes without thread_id", async () => {
      const batch = createMockBatch(3);
      const segment: VLMSegment = {
        segment_id: "seg_1",
        screen_ids: [1, 2, 3],
        event: {
          title: "current_user learning",
          summary: "current_user is learning new concept",
          confidence: 8,
          importance: 7,
        },
        derived: {
          knowledge: [{ title: "Reusable knowledge", summary: "Can be used across threads" }],
          state: [],
          procedure: [],
          plan: [],
        },
        merge_hint: { decision: "NEW" },
        keywords: [],
      };
      const vlmIndex = createMockVLMIndex([segment]);

      await processor.expandToNodes(vlmIndex, batch);

      // Knowledge node should not have thread_id (it's cross-thread)
      const knowledgeNode = createdNodes.find((n) => n.kind === "knowledge");
      expect(knowledgeNode).toBeDefined();
      expect(knowledgeNode?.threadId).toBeUndefined();

      // But it should have sourceEventId for traceability
      expect(knowledgeNode?.sourceEventId).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should return error result when node creation fails", async () => {
      // Mock createNode to throw
      const { contextGraphService } = await import("./context-graph-service");
      vi.mocked(contextGraphService.createNode).mockRejectedValueOnce(new Error("DB error"));

      const batch = createMockBatch(3);
      const vlmIndex = createMockVLMIndex([createMockSegment("seg_1", [1, 2, 3])]);

      const result = await processor.expandToNodes(vlmIndex, batch);

      expect(result.success).toBe(false);
      expect(result.error).toContain("DB error");
      expect(result.nodeIds.length).toBe(0);
    });
  });
});
