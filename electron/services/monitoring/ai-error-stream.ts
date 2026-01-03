import { EventEmitter } from "events";
import { and, eq, gte, desc } from "drizzle-orm";
import { getDb } from "../../database";
import { llmUsageEvents } from "../../database/schema";
import { getLogger } from "../logger";
import { RingBuffer } from "./ring-buffer";
import type { AIErrorEvent } from "./monitoring-types";

const logger = getLogger("ai-error-stream");

/**
 * AIErrorStream
 *
 * Provides real-time AI error event streaming for monitoring dashboard.
 * Queries llm_usage_events table for failed events and maintains a ring buffer
 * of recent errors for dashboard initialization.
 *
 * Features:
 * - Polls for new errors at configurable interval
 * - Emits 'error' events for SSE streaming
 * - Maintains buffer of recent errors for client reconnection
 * - Calculates error rates for 1min/5min windows
 */
export class AIErrorStream extends EventEmitter {
  private static instance: AIErrorStream | null = null;

  private pollInterval: NodeJS.Timeout | null = null;
  private buffer: RingBuffer<AIErrorEvent>;
  private lastSeenTs: number = 0;
  private pollIntervalMs: number;
  private running: boolean = false;

  private constructor() {
    super();
    this.buffer = new RingBuffer<AIErrorEvent>(100);
    this.pollIntervalMs = 5000; // Poll every 5 seconds
  }

  async queryRecentErrors(limit: number = 50): Promise<AIErrorEvent[]> {
    const now = Date.now();
    const fromTs = now - 3600000; // Last hour

    try {
      const db = getDb();

      const errors = await db
        .select({
          ts: llmUsageEvents.ts,
          capability: llmUsageEvents.capability,
          operation: llmUsageEvents.operation,
          model: llmUsageEvents.model,
          errorCode: llmUsageEvents.errorCode,
        })
        .from(llmUsageEvents)
        .where(and(eq(llmUsageEvents.status, "failed"), gte(llmUsageEvents.ts, fromTs)))
        .orderBy(desc(llmUsageEvents.ts))
        .limit(limit)
        .all();

      // Return in chronological order (oldest first)
      return errors.reverse().map((error) => ({
        ts: error.ts,
        capability: error.capability,
        operation: error.operation,
        model: error.model,
        errorCode: error.errorCode,
      }));
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to query recent errors"
      );
      return [];
    }
  }

  static getInstance(): AIErrorStream {
    if (!AIErrorStream.instance) {
      AIErrorStream.instance = new AIErrorStream();
    }
    return AIErrorStream.instance;
  }

  /**
   * Start polling for new errors
   */
  start(): void {
    if (this.running) {
      logger.debug("AIErrorStream already running");
      return;
    }

    this.running = true;
    this.lastSeenTs = Date.now() - 60000; // Start from 1 minute ago

    // Initial load
    void this.loadRecentErrors();

    // Start polling
    this.pollInterval = setInterval(() => {
      void this.pollNewErrors();
    }, this.pollIntervalMs);

    logger.info({ pollIntervalMs: this.pollIntervalMs }, "AIErrorStream started");
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    logger.info("AIErrorStream stopped");
  }

  /**
   * Get recent errors from buffer
   */
  getRecentErrors(count?: number): AIErrorEvent[] {
    if (count === undefined) {
      return this.buffer.toArray();
    }
    return this.buffer.getRecent(count).reverse();
  }

  /**
   * Calculate error rate for a time window
   */
  async getErrorRate(windowMs: number): Promise<{ vlm: number; text: number; embedding: number }> {
    const now = Date.now();
    const fromTs = now - windowMs;

    try {
      const db = getDb();

      const failedCounts = await db
        .select({
          capability: llmUsageEvents.capability,
        })
        .from(llmUsageEvents)
        .where(and(eq(llmUsageEvents.status, "failed"), gte(llmUsageEvents.ts, fromTs)))
        .all();

      const counts = { vlm: 0, text: 0, embedding: 0 };
      for (const row of failedCounts) {
        if (row.capability === "vlm") counts.vlm++;
        else if (row.capability === "text") counts.text++;
        else if (row.capability === "embedding") counts.embedding++;
      }

      return counts;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to get error rate"
      );
      return { vlm: 0, text: 0, embedding: 0 };
    }
  }

  /**
   * Get error counts grouped by error code
   */
  async getErrorsByCode(limit: number = 10): Promise<Array<{ errorCode: string; count: number }>> {
    const now = Date.now();
    const fromTs = now - 3600000; // Last hour

    try {
      const db = getDb();

      const results = await db
        .select({
          errorCode: llmUsageEvents.errorCode,
        })
        .from(llmUsageEvents)
        .where(and(eq(llmUsageEvents.status, "failed"), gte(llmUsageEvents.ts, fromTs)))
        .all();

      // Count by error code
      const counts = new Map<string, number>();
      for (const row of results) {
        const code = row.errorCode ?? "unknown";
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }

      // Sort by count and take top N
      return Array.from(counts.entries())
        .map(([errorCode, count]) => ({ errorCode, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to get errors by code"
      );
      return [];
    }
  }

  /**
   * Check if stream is running
   */
  isRunning(): boolean {
    return this.running;
  }

  private async loadRecentErrors(): Promise<void> {
    const now = Date.now();
    const fromTs = now - 3600000; // Last hour

    try {
      const db = getDb();

      const errors = await db
        .select({
          ts: llmUsageEvents.ts,
          capability: llmUsageEvents.capability,
          operation: llmUsageEvents.operation,
          model: llmUsageEvents.model,
          errorCode: llmUsageEvents.errorCode,
        })
        .from(llmUsageEvents)
        .where(and(eq(llmUsageEvents.status, "failed"), gte(llmUsageEvents.ts, fromTs)))
        .orderBy(desc(llmUsageEvents.ts))
        .limit(100)
        .all();

      // Add to buffer in chronological order (oldest first)
      for (const error of errors.reverse()) {
        const event: AIErrorEvent = {
          ts: error.ts,
          capability: error.capability,
          operation: error.operation,
          model: error.model,
          errorCode: error.errorCode,
        };
        this.buffer.push(event);
        if (error.ts > this.lastSeenTs) {
          this.lastSeenTs = error.ts;
        }
      }

      logger.debug({ count: errors.length }, "Loaded recent errors");
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to load recent errors"
      );
    }
  }

  private async pollNewErrors(): Promise<void> {
    if (!this.running) return;

    try {
      const db = getDb();

      const errors = await db
        .select({
          ts: llmUsageEvents.ts,
          capability: llmUsageEvents.capability,
          operation: llmUsageEvents.operation,
          model: llmUsageEvents.model,
          errorCode: llmUsageEvents.errorCode,
        })
        .from(llmUsageEvents)
        .where(
          and(eq(llmUsageEvents.status, "failed"), gte(llmUsageEvents.ts, this.lastSeenTs + 1))
        )
        .orderBy(llmUsageEvents.ts)
        .all();

      for (const error of errors) {
        const event: AIErrorEvent = {
          ts: error.ts,
          capability: error.capability,
          operation: error.operation,
          model: error.model,
          errorCode: error.errorCode,
        };
        this.buffer.push(event);
        this.emit("error", event);

        if (error.ts > this.lastSeenTs) {
          this.lastSeenTs = error.ts;
        }
      }

      if (errors.length > 0) {
        logger.debug({ count: errors.length }, "Polled new errors");
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to poll new errors"
      );
    }
  }
}

export const aiErrorStream = AIErrorStream.getInstance();
