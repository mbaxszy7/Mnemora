/**
 * AI Failure Circuit Breaker
 *
 * Monitors VLM, Text LLM, and Embedding failures using a 60-second sliding window.
 * When >= 3 failures occur, automatically stops screen capture and notifies the user.
 * Recovery is attempted only when LLM configuration is saved (no periodic pings).
 */

import { BrowserWindow } from "electron";
import { getLogger } from "./logger";
import { IPC_CHANNELS } from "@shared/ipc-types";
import type { AIFailureFuseTrippedPayload } from "@shared/ipc-types";
import type { LLMConfig } from "@shared/llm-config-types";
import { llmConfigService } from "./llm-config-service";

const logger = getLogger("ai-failure-circuit-breaker");

export type AICapability = "vlm" | "text" | "embedding";

interface FailureEvent {
  ts: number;
  capability: AICapability;
  message: string;
  name?: string;
}

type CaptureStatus = { status: string };
type CaptureControlCallbacks = {
  stop: () => void;
  start: () => Promise<void> | void;
  getState?: () => CaptureStatus | null | undefined;
};

class AIFailureCircuitBreaker {
  private readonly windowMs = 60_000;
  private readonly threshold = 3;

  private events: FailureEvent[] = [];
  private tripped = false;
  private shouldAutoResumeCapture = false;
  private captureControlCallbacks: CaptureControlCallbacks | null = null;

  /**
   * Register callbacks for screen capture control
   * Called by screen-capture-module to avoid circular dependency
   */
  registerCaptureControlCallbacks(callbacks: CaptureControlCallbacks): void {
    this.captureControlCallbacks = callbacks;
  }

  /**
   * Record a failure event and check if circuit should trip
   */
  recordFailure(capability: AICapability, err: unknown): void {
    const now = Date.now();
    const e = err instanceof Error ? err : new Error(String(err));

    this.events.push({
      ts: now,
      capability,
      message: e.message,
      name: e.name,
    });

    // Prune old events outside the sliding window
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }

    logger.debug(
      { capability, eventCount: this.events.length, tripped: this.tripped },
      "Recorded AI failure"
    );

    if (!this.tripped && this.events.length >= this.threshold) {
      this.trip(this.events[this.events.length - 1]);
    }
  }

  /**
   * Reset the circuit breaker state
   */
  reset(): void {
    logger.info("Resetting circuit breaker");
    this.events = [];
    this.tripped = false;
    this.shouldAutoResumeCapture = false;
  }

  /**
   * Check if the circuit breaker is currently tripped
   */
  isTripped(): boolean {
    return this.tripped;
  }

  /**
   * Trip the circuit breaker - stop capture and notify user
   */
  private trip(last: FailureEvent): void {
    this.tripped = true;

    logger.warn(
      { eventCount: this.events.length, lastCapability: last.capability },
      "Circuit breaker tripped - stopping screen capture"
    );

    const currentStatus = this.captureControlCallbacks?.getState?.()?.status;
    this.shouldAutoResumeCapture =
      currentStatus === "running" || currentStatus === "paused" || currentStatus === "idle";

    // Stop screen capture via callback
    if (this.captureControlCallbacks?.stop) {
      try {
        this.captureControlCallbacks.stop();
      } catch (error) {
        logger.error({ error }, "Failed to stop screen capture during circuit trip");
      }
    }

    // Notify all renderer windows
    const payload: AIFailureFuseTrippedPayload = {
      windowMs: this.windowMs,
      threshold: this.threshold,
      count: this.events.length,
      last: {
        capability: last.capability,
        message: last.message,
      },
    };

    BrowserWindow.getAllWindows().forEach((win) => {
      try {
        win.webContents.send(IPC_CHANNELS.AI_FAILURE_FUSE_TRIPPED, payload);
      } catch (error) {
        logger.error({ error }, "Failed to send fuse tripped event to window");
      }
    });
  }

  /**
   * Handle config save: validate once, and resume if healthy & previously running
   */
  async handleConfigSaved(config: LLMConfig): Promise<void> {
    if (!this.tripped) return;

    logger.info("Config saved - validating for circuit recovery");

    try {
      const result = await llmConfigService.validateConfiguration(config);

      if (result.success) {
        logger.info("LLM configuration validated successfully - resuming capture");

        // Reset the circuit breaker
        this.reset();

        // Restart screen capture via callback
        if (this.shouldAutoResumeCapture && this.captureControlCallbacks?.start) {
          try {
            await this.captureControlCallbacks.start();
          } catch (error) {
            logger.error({ error }, "Failed to restart screen capture after recovery");
          }
        }
      } else {
        logger.debug(
          {
            textSuccess: result.textCompletion?.success,
            visionSuccess: result.vision?.success,
            embeddingSuccess: result.embedding?.success,
          },
          "LLM configuration validation still failing"
        );
      }
    } catch (error) {
      logger.error({ error }, "Error during recovery attempt");
    }
  }
}

export const aiFailureCircuitBreaker = new AIFailureCircuitBreaker();
