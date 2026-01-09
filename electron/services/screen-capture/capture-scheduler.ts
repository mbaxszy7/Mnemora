/**
 * ScreenCaptureScheduler - Self-correcting capture scheduling with delay compensation
 */

import { EventEmitter } from "events";
import type {
  SchedulerConfig,
  CaptureSchedulerState,
  CaptureResult,
  SchedulerEvent,
  SchedulerEventHandler,
  CaptureStartEvent,
  CaptureCompleteEvent,
  CaptureErrorEvent,
  CaptureSchedulerStateEvent,
  PreferencesChangedEvent,
  SchedulerEventPayload,
} from "./types";
import { DEFAULT_SCHEDULER_CONFIG } from "./types";
import { getLogger } from "../logger";

const logger = getLogger("scheduler");

/** Calculate next delay with compensation for execution time */
export function calculateNextDelay(
  executionTime: number,
  interval: number,
  minDelay: number
): number {
  const compensatedDelay = interval - executionTime;
  return Math.max(compensatedDelay, minDelay);
}

export interface IScreenCaptureScheduler {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  updateConfig(config: Partial<SchedulerConfig>): void;
  getState(): CaptureSchedulerState;
  notifyPreferencesChanged(): void;
  on<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void;
  off<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void;
}

export type CaptureTask = () => Promise<CaptureResult[]>;

export class ScreenCaptureScheduler implements IScreenCaptureScheduler {
  private config: SchedulerConfig;
  private state: CaptureSchedulerState;
  private emitter: EventEmitter;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private captureTask!: CaptureTask;
  private generation = 0;

  constructor(config: Partial<SchedulerConfig> = {}, captureTask: CaptureTask = async () => []) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    // Default no-op capture task for testing state machine without actual captures
    this.captureTask = captureTask;
    this.emitter = new EventEmitter();
    this.state = {
      status: "idle",
      lastCaptureTime: null,
      nextCaptureTime: null,
      captureCount: 0,
      errorCount: 0,
    };

    if (this.config.autoStart) {
      this.start();
    }
  }

  start(): void {
    logger.info({ currentStatus: this.state.status }, "Scheduler start() called");

    if (this.state.status === "running") {
      logger.info("Scheduler already running, ignoring start()");
      return; // Already running, ignore
    }

    // Allow restarting from stopped state (needed for hot reload scenarios)
    // Reset state if stopped
    if (this.state.status === "stopped") {
      logger.info("Restarting scheduler from stopped state");
      this.state = {
        status: "idle",
        lastCaptureTime: null,
        nextCaptureTime: null,
        captureCount: 0,
        errorCount: 0,
      };
    }

    const previousState = this.state.status;
    this.generation++;
    this.state.status = "running";
    this.emitStateChange(previousState, "running");
    logger.info({ interval: this.config.interval }, "Scheduler started, scheduling first capture");
    this.scheduleNext(this.config.interval);
  }

  stop(): void {
    if (this.state.status === "stopped") {
      return; // Already stopped, no-op
    }

    this.cancelTimer();
    const previousState = this.state.status;
    this.generation++;
    this.state.status = "stopped";
    this.state.nextCaptureTime = null;
    this.emitStateChange(previousState, "stopped");
  }

  pause(): void {
    if (this.state.status !== "running") {
      return; // Can only pause when running
    }

    this.cancelTimer();
    const previousState = this.state.status;
    this.generation++;
    this.state.status = "paused";
    this.state.nextCaptureTime = null;
    this.emitStateChange(previousState, "paused");
  }

  resume(): void {
    if (this.state.status !== "paused") {
      return; // Can only resume when paused
    }

    const previousState = this.state.status;
    this.generation++;
    this.state.status = "running";
    this.emitStateChange(previousState, "running");
    this.scheduleNext(this.config.interval);
  }

  updateConfig(config: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  notifyPreferencesChanged(): void {
    const event: PreferencesChangedEvent = {
      type: "preferences:changed",
      timestamp: Date.now(),
    };
    this.emitter.emit("preferences:changed", event);
  }

  getState(): CaptureSchedulerState {
    return { ...this.state };
  }

  on<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void {
    this.emitter.on(event, handler);
  }

  off<T extends SchedulerEventPayload>(
    event: SchedulerEvent,
    handler: SchedulerEventHandler<T>
  ): void {
    this.emitter.off(event, handler);
  }

  private scheduleNext(delay: number): void {
    const nextTime = Date.now() + delay;
    this.state.nextCaptureTime = nextTime;

    logger.info({ delay, nextTime: new Date(nextTime).toISOString() }, "Scheduling next capture");

    this.timerId = setTimeout(() => {
      this.timerId = null;
      logger.info("Timer fired, executing capture loop");
      this.executeCaptureLoop();
    }, delay);
  }

  private async executeCaptureLoop(): Promise<void> {
    if (this.state.status !== "running") {
      return;
    }

    const generationAtStart = this.generation;

    const captureId = this.generateCaptureId();
    const startTime = Date.now();

    // Emit capture:start event
    this.emitCaptureStart(captureId, startTime);

    try {
      let result: CaptureResult[] | null = null;

      logger.info("Calling captureTask()...");
      result = await this.captureTask();
      logger.info("captureTask() completed");

      // If paused/stopped/restarted while captureTask was running, ignore this result.
      if (this.generation !== generationAtStart || this.state.status !== "running") {
        return;
      }

      const executionTime = Date.now() - startTime;
      this.state.lastCaptureTime = startTime;
      this.state.captureCount++;

      // Emit capture:complete event
      if (result) {
        this.emitCaptureComplete(captureId, result, executionTime);
      }

      // Schedule next capture with delay compensation
      if (this.state.status === "running") {
        const nextDelay = calculateNextDelay(
          executionTime,
          this.config.interval,
          this.config.minDelay
        );
        this.scheduleNext(nextDelay);
      }
    } catch (error) {
      const executionTime = Date.now() - startTime;

      // If paused/stopped/restarted while captureTask was running, ignore this error.
      if (this.generation !== generationAtStart || this.state.status !== "running") {
        return;
      }

      this.state.errorCount++;

      // Log the error
      logger.error({ error, captureId }, "Capture task failed");

      // Emit capture:error event
      this.emitCaptureError(captureId, error instanceof Error ? error : new Error(String(error)));

      // Continue scheduling despite error (error tolerance)
      if (this.state.status === "running") {
        const nextDelay = calculateNextDelay(
          executionTime,
          this.config.interval,
          this.config.minDelay
        );
        this.scheduleNext(nextDelay);
      }
    }
  }

  private cancelTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private generateCaptureId(): string {
    return `capture-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private emitCaptureStart(captureId: string, timestamp: number): void {
    const event: CaptureStartEvent = {
      type: "capture:start",
      timestamp,
      captureId,
    };
    this.emitter.emit("capture:start", event);
  }

  private emitCaptureComplete(
    captureId: string,
    result: CaptureResult[],
    executionTime: number
  ): void {
    const event: CaptureCompleteEvent = {
      type: "capture:complete",
      timestamp: Date.now(),
      captureId,
      result,
      executionTime,
    };
    this.emitter.emit("capture:complete", event);
  }

  private emitCaptureError(captureId: string, error: Error): void {
    const event: CaptureErrorEvent = {
      type: "capture:error",
      timestamp: Date.now(),
      captureId,
      error,
    };
    this.emitter.emit("capture:error", event);
  }

  private emitStateChange(
    previousState: CaptureSchedulerState["status"],
    currentState: CaptureSchedulerState["status"]
  ): void {
    const event: CaptureSchedulerStateEvent = {
      type: "capture-scheduler:state",
      timestamp: Date.now(),
      previousState,
      currentState,
    };
    this.emitter.emit("capture-scheduler:state", event);
  }
}
