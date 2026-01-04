import { describe, it, expect, beforeEach } from "vitest";
import { aiRequestTraceBuffer } from "./ai-request-trace";

describe("AIRequestTraceBuffer", () => {
  beforeEach(() => {
    aiRequestTraceBuffer.clear();
  });

  describe("record", () => {
    it("should record a trace and emit event", () => {
      const traces: unknown[] = [];
      const handler = (trace: unknown) => traces.push(trace);
      aiRequestTraceBuffer.on("trace", handler);

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "vlm",
        operation: "vlm_analyze_shard",
        model: "test-model",
        durationMs: 1234,
        status: "succeeded",
        responsePreview: '{"test": true}',
      });

      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        capability: "vlm",
        operation: "vlm_analyze_shard",
        status: "succeeded",
      });

      aiRequestTraceBuffer.off("trace", handler);
    });

    it("should truncate long response previews", () => {
      const longResponse = "x".repeat(15000);

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "text_expand",
        model: "test-model",
        durationMs: 500,
        status: "succeeded",
        responsePreview: longResponse,
      });

      const traces = aiRequestTraceBuffer.getRecent();
      expect(traces.text[0].responsePreview!.length).toBeLessThanOrEqual(12000);
      expect(traces.text[0].responsePreview!.endsWith("...")).toBe(true);
    });

    it("should truncate long error previews", () => {
      const longError = "e".repeat(2000);

      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "embedding",
        operation: "embedding_node",
        model: "test-model",
        durationMs: 100,
        status: "failed",
        errorPreview: longError,
      });

      const traces = aiRequestTraceBuffer.getRecent();
      expect(traces.embedding[0].errorPreview!.length).toBeLessThanOrEqual(1000);
      expect(traces.embedding[0].errorPreview!.endsWith("...")).toBe(true);
    });
  });

  describe("getRecent", () => {
    it("should return traces grouped by capability", () => {
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "vlm",
        operation: "op1",
        model: "m",
        durationMs: 100,
        status: "succeeded",
      });
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "op2",
        model: "m",
        durationMs: 200,
        status: "succeeded",
      });
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "embedding",
        operation: "op3",
        model: "m",
        durationMs: 300,
        status: "failed",
      });

      const traces = aiRequestTraceBuffer.getRecent();
      expect(traces.vlm).toHaveLength(1);
      expect(traces.text).toHaveLength(1);
      expect(traces.embedding).toHaveLength(1);
    });
  });

  describe("getAllRecent", () => {
    it("should return all traces sorted by timestamp descending", () => {
      const now = Date.now();

      aiRequestTraceBuffer.record({
        ts: now - 2000,
        capability: "vlm",
        operation: "oldest",
        model: "m",
        durationMs: 100,
        status: "succeeded",
      });
      aiRequestTraceBuffer.record({
        ts: now,
        capability: "text",
        operation: "newest",
        model: "m",
        durationMs: 200,
        status: "succeeded",
      });
      aiRequestTraceBuffer.record({
        ts: now - 1000,
        capability: "embedding",
        operation: "middle",
        model: "m",
        durationMs: 300,
        status: "succeeded",
      });

      const all = aiRequestTraceBuffer.getAllRecent();
      expect(all).toHaveLength(3);
      expect(all[0].operation).toBe("newest");
      expect(all[1].operation).toBe("middle");
      expect(all[2].operation).toBe("oldest");
    });
  });

  describe("buffer limit", () => {
    it("should keep only 20 traces per capability", () => {
      // Add 25 VLM traces
      for (let i = 0; i < 25; i++) {
        aiRequestTraceBuffer.record({
          ts: Date.now() + i,
          capability: "vlm",
          operation: `op${i}`,
          model: "m",
          durationMs: 100,
          status: "succeeded",
        });
      }

      const traces = aiRequestTraceBuffer.getRecent();
      expect(traces.vlm.length).toBeLessThanOrEqual(20);
    });
  });

  describe("clear", () => {
    it("should clear all buffers", () => {
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "vlm",
        operation: "op",
        model: "m",
        durationMs: 100,
        status: "succeeded",
      });
      aiRequestTraceBuffer.record({
        ts: Date.now(),
        capability: "text",
        operation: "op",
        model: "m",
        durationMs: 100,
        status: "succeeded",
      });

      aiRequestTraceBuffer.clear();

      const traces = aiRequestTraceBuffer.getRecent();
      expect(traces.vlm).toHaveLength(0);
      expect(traces.text).toHaveLength(0);
      expect(traces.embedding).toHaveLength(0);
    });
  });
});
