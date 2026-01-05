/**
 * AI Request Trace Buffer
 *
 * In-memory ring buffer for storing recent AI request traces.
 * Used for monitoring dashboard - NOT persisted to database.
 *
 * Stores the last 20 requests per capability (VLM/Text/Embedding)
 * with response previews and error details.
 */

import { EventEmitter } from "events";
import { RingBuffer } from "./ring-buffer";
import type { AIRequestTrace } from "./monitoring-types";

// Maximum characters for response/error previews
const MAX_RESPONSE_PREVIEW_CHARS = 12000;
const MAX_ERROR_PREVIEW_CHARS = 1000;
const BUFFER_SIZE_PER_CAPABILITY = 20;

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * AI Request Trace Buffer
 *
 * Manages ring buffers for each AI capability and emits events
 * when new traces are recorded (for SSE streaming).
 */
class AIRequestTraceBuffer extends EventEmitter {
  private vlmBuffer: RingBuffer<AIRequestTrace>;
  private textBuffer: RingBuffer<AIRequestTrace>;
  private embeddingBuffer: RingBuffer<AIRequestTrace>;

  constructor() {
    super();
    this.vlmBuffer = new RingBuffer<AIRequestTrace>(BUFFER_SIZE_PER_CAPABILITY);
    this.textBuffer = new RingBuffer<AIRequestTrace>(BUFFER_SIZE_PER_CAPABILITY);
    this.embeddingBuffer = new RingBuffer<AIRequestTrace>(BUFFER_SIZE_PER_CAPABILITY);
  }

  /**
   * Record a new AI request trace
   */
  record(
    trace: Omit<AIRequestTrace, "responsePreview" | "errorPreview"> & {
      responsePreview?: string;
      errorPreview?: string;
    }
  ): void {
    // Truncate previews to enforce memory limits
    const sanitizedTrace: AIRequestTrace = {
      ...trace,
      responsePreview: trace.responsePreview
        ? truncate(trace.responsePreview, MAX_RESPONSE_PREVIEW_CHARS)
        : undefined,
      errorPreview: trace.errorPreview
        ? truncate(trace.errorPreview, MAX_ERROR_PREVIEW_CHARS)
        : undefined,
      images: trace.images,
    };

    // Add to appropriate buffer
    const buffer = this.getBuffer(trace.capability);
    buffer.push(sanitizedTrace);

    // Emit event for SSE streaming
    this.emit("trace", sanitizedTrace);
  }

  /**
   * Get recent traces grouped by capability
   */
  getRecent(): {
    vlm: AIRequestTrace[];
    text: AIRequestTrace[];
    embedding: AIRequestTrace[];
  } {
    return {
      vlm: this.vlmBuffer.getRecent(BUFFER_SIZE_PER_CAPABILITY),
      text: this.textBuffer.getRecent(BUFFER_SIZE_PER_CAPABILITY),
      embedding: this.embeddingBuffer.getRecent(BUFFER_SIZE_PER_CAPABILITY),
    };
  }

  /**
   * Get all recent traces as a flat array (sorted by timestamp, newest first)
   */
  getAllRecent(): AIRequestTrace[] {
    const all = [
      ...this.vlmBuffer.getRecent(BUFFER_SIZE_PER_CAPABILITY),
      ...this.textBuffer.getRecent(BUFFER_SIZE_PER_CAPABILITY),
      ...this.embeddingBuffer.getRecent(BUFFER_SIZE_PER_CAPABILITY),
    ];
    return all.sort((a, b) => b.ts - a.ts);
  }

  /**
   * Clear all buffers
   */
  clear(): void {
    this.vlmBuffer.clear();
    this.textBuffer.clear();
    this.embeddingBuffer.clear();
  }

  private getBuffer(capability: "vlm" | "text" | "embedding"): RingBuffer<AIRequestTrace> {
    switch (capability) {
      case "vlm":
        return this.vlmBuffer;
      case "text":
        return this.textBuffer;
      case "embedding":
        return this.embeddingBuffer;
    }
  }
}

export const aiRequestTraceBuffer = new AIRequestTraceBuffer();
