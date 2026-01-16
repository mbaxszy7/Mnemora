import { describe, it, expect } from "vitest";

import { VLMOutputProcessedSchema } from "./schemas";

describe("VLMOutputProcessedSchema", () => {
  it("truncates and caps fields", () => {
    const long = "x".repeat(200);
    const input = {
      nodes: [
        {
          screenshot_index: 1,
          title: long,
          summary: "y".repeat(600),
          app_context: { app_hint: null, window_title: null, source_key: "window:1" },
          knowledge: null,
          state_snapshot: null,
          entities: Array.from({ length: 12 }, (_, i) => ({ name: `Entity-${i}`, type: "other" })),
          action_items: Array.from({ length: 7 }, () => ({ action: "todo", source: "explicit" })),
          ui_text_snippets: Array.from({ length: 10 }, () => "snippet"),
          importance: 11,
          confidence: -1,
          keywords: Array.from({ length: 10 }, (_, i) => `k${i}`),
        },
      ],
    };

    const parsed = VLMOutputProcessedSchema.parse(input);
    const node = parsed.nodes[0];

    expect(node.title.length).toBe(100);
    expect(node.summary.length).toBe(500);
    expect(node.entities.length).toBe(10);
    expect(node.actionItems?.length).toBe(5);
    expect(node.uiTextSnippets.length).toBe(5);
    expect(node.importance).toBe(10);
    expect(node.confidence).toBe(0);
    expect(node.keywords.length).toBe(5);
  });
});
