import { BrowserWindow } from "electron";

import { IPC_CHANNELS } from "@shared/ipc-types";
import type { AIFailureFuseTrippedPayload } from "@shared/ipc-types";
import type { LLMConfig } from "@shared/llm-config-types";
import { getLogger } from "./logger";
import { aiRuntimeEventBus } from "./ai-runtime/event-bus";
import { processingConfig } from "./screenshot-processing/config";
import type { CaptureSchedulerState } from "./screen-capture/types";
import { LLMConfigService } from "./llm-config-service";

/**
 * AI capability types (used across semaphore/tuner/breaker and all call sites).
 *
 * - `vlm`: Vision model related (screenshot understanding/segment analysis, etc.)
 * - `text`: Pure text LLM (summary, deep search, merge hint, etc.)
 * - `embedding`: Vectorization (write/update vector index)
 */
export type AICapability = "vlm" | "text" | "embedding";

const runtimeLogger = getLogger("ai-runtime-service");

/**
 * Default broadcast implementation when breaker trips: send IPC events to all BrowserWindows.
 *
 * Design choices:
 * - Module-level placement avoids closure creation/`this` binding during `AIRuntimeService` construction
 * - Can be replaced with mock via dependency injection for unit tests
 */
function defaultSendToAllWindows(payload: AIFailureFuseTrippedPayload): void {
  try {
    BrowserWindow.getAllWindows().forEach((win) => {
      try {
        win.webContents.send(IPC_CHANNELS.AI_FAILURE_FUSE_TRIPPED, payload);
      } catch (error) {
        runtimeLogger.error({ error }, "Failed to send fuse tripped event to window");
      }
    });
  } catch (error) {
    runtimeLogger.error({ error }, "Failed to send fuse tripped event");
  }
}

/**
 * Default config validation implementation when breaker recovers.
 *
 * After breaker trips:
 * - Wait for user to save config (LLM_CONFIG_SAVE)
 * - Call validate; only allow auto-resume on success
 */
async function defaultValidateConfig(config: LLMConfig): Promise<{ success: boolean }> {
  const res = await LLMConfigService.getInstance().validateConfiguration(config);
  return { success: res.success };
}

// =========================================================================
// Semaphore
// =========================================================================

/**
 * A simple counting semaphore.
 *
 * Purpose:
 * - Provides a "global concurrency limit" for different AI capabilities to prevent too many concurrent requests
 * - Supports dynamic concurrency adjustment (`setLimit`) for adaptive tuner
 *
 * Key fields:
 * - `limit`: Current maximum allowed concurrency (upper bound)
 * - `inUse`: Number of permits currently acquired (active concurrent tasks)
 * - `permits`: Number of permits currently available (can be acquired immediately)
 * - `waiting`: Wait queue (FIFO). Wakes up in order when `permits` becomes positive.
 */
class Semaphore {
  /** Available permits (can be acquired immediately) */
  private permits: number;

  /** Concurrency limit (max concurrent inUse) */
  private limit: number;

  /** Used permits (number of tasks currently in progress) */
  private inUse: number;

  /**
   * Wait queue (FIFO). When permits become available, shift and wake up waiters.
   */
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    if (permits <= 0) {
      throw new Error("Semaphore permits must be positive");
    }
    this.limit = Math.floor(permits);
    this.permits = this.limit;
    this.inUse = 0;
  }

  getLimit(): number {
    return this.limit;
  }

  setLimit(nextLimit: number): void {
    const next = Math.floor(nextLimit);
    if (!Number.isFinite(next) || next <= 0) {
      throw new Error("Semaphore limit must be positive");
    }

    // Recalculate available permits after limit adjustment.
    // Note: When limit drops below inUse, available permits become 0 (no capacity).
    this.limit = next;
    this.permits = Math.max(0, this.limit - this.inUse);

    while (this.permits > 0 && this.waiting.length > 0) {
      const nextWaiter = this.waiting.shift();
      if (!nextWaiter) break;
      nextWaiter();
    }
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      this.inUse++;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.waiting.push(() => {
        // Only consume permit when awakened.
        // Precondition for waking: release/setLimit confirms current capacity.
        this.permits--;
        this.inUse++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    if (this.inUse <= 0) {
      return;
    }

    this.inUse--;
    const maxPermits = Math.max(0, this.limit - this.inUse);
    this.permits = Math.min(this.permits + 1, maxPermits);

    if (this.permits <= 0) {
      return;
    }

    const next = this.waiting.shift();
    if (next) {
      next();
    }
  }
}

class AISemaphoreManager {
  /**
   * One semaphore per capability.
   *
   * Design choice: lazy init (create on demand).
   * - Avoids unnecessary initialization at main process startup
   * - Reduces side effects in tests
   */
  private _vlm: Semaphore | null = null;
  private _text: Semaphore | null = null;
  private _embedding: Semaphore | null = null;

  /**
   * Returns the semaphore for the given capability.
   *
   * Design choices:
   * - Unified routing ensures callers only care about capability, not the specific instance
   * - Internal getters ensure lazy init
   */
  private ensure(capability: AICapability): Semaphore {
    switch (capability) {
      case "vlm":
        return this.vlm;
      case "text":
        return this.text;
      case "embedding":
        return this.embedding;
    }
  }

  get vlm(): Semaphore {
    if (!this._vlm) {
      this._vlm = new Semaphore(processingConfig.ai.vlmGlobalConcurrency);
    }
    return this._vlm;
  }

  get text(): Semaphore {
    if (!this._text) {
      this._text = new Semaphore(processingConfig.ai.textGlobalConcurrency);
    }
    return this._text;
  }

  get embedding(): Semaphore {
    if (!this._embedding) {
      this._embedding = new Semaphore(processingConfig.ai.embeddingGlobalConcurrency);
    }
    return this._embedding;
  }

  /** Acquire permit for the specified capability (caller must ensure release() is eventually called) */
  acquire(capability: AICapability): Promise<() => void> {
    return this.ensure(capability).acquire();
  }

  /** Returns current concurrency limit of the semaphore */
  getLimit(capability: AICapability): number {
    return this.ensure(capability).getLimit();
  }

  /** Sets current concurrency limit of the semaphore (for tuner dynamic adjustment) */
  setLimit(capability: AICapability, limit: number): void {
    this.ensure(capability).setLimit(limit);
  }

  /**
   * Test-only accessor.
   */
  getSemaphore(capability: AICapability): Semaphore {
    return this.ensure(capability);
  }
}

// =========================================================================
// Adaptive Concurrency Tuner (AIMD)
// =========================================================================

type CapabilityState = {
  /** Base concurrency limit (usually from processingConfig.ai.*GlobalConcurrency) */
  base: number;

  /** Current concurrency limit (adjusted by degrade/recover) */
  current: number;

  /** Sliding window: true=success / false=failure, used to calculate failure rate */
  window: boolean[];

  /** Consecutive failure count (for fast degradation trigger) */
  consecutiveFailures: number;

  /** Consecutive success count (for recovery trigger) */
  consecutiveSuccesses: number;

  /** Timestamp of last concurrency adjustment, used for cooldown */
  lastAdjustedAt: number;
};

/**
 * Adaptive Concurrency Tuner.
 *
 * Goal: Gradually recover to base concurrency when AI requests are stable;
 * quickly degrade when failures increase, reducing error cascades and provider rate-limit risks.
 *
 * Mechanism overview:
 * - Maintains a success/failure sliding window + consecutive success/failure counters
 * - After each record, checks if degrade/recover is needed when cooldown allows
 * - Degrade: current /= 2 (floor at adaptiveMinConcurrency)
 * - Recover: current += adaptiveRecoveryStep, up to base
 */
class AIConcurrencyTuner {
  private readonly logger = getLogger("ai-concurrency-tuner");
  private readonly nowFn: () => number;
  private readonly semaphores: Pick<AISemaphoreManager, "setLimit">;

  private state: Record<AICapability, CapabilityState>;

  constructor(args: { nowFn: () => number; semaphores: Pick<AISemaphoreManager, "setLimit"> }) {
    this.nowFn = args.nowFn;
    this.semaphores = args.semaphores;

    const now = this.nowFn();
    this.state = {
      vlm: this.makeState(processingConfig.ai.vlmGlobalConcurrency, now),
      text: this.makeState(processingConfig.ai.textGlobalConcurrency, now),
      embedding: this.makeState(processingConfig.ai.embeddingGlobalConcurrency, now),
    };
  }

  getCurrentLimit(capability: AICapability): number {
    return this.state[capability].current;
  }

  recordSuccess(capability: AICapability): void {
    this.record(capability, true);
  }

  recordFailure(capability: AICapability, error?: unknown): void {
    this.record(capability, false, error);
  }

  private makeState(base: number, now: number): CapabilityState {
    const normalizedBase = Number.isFinite(base) && base > 0 ? Math.floor(base) : 1;
    return {
      base: normalizedBase,
      current: normalizedBase,
      window: [],
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastAdjustedAt: now,
    };
  }

  private record(capability: AICapability, ok: boolean, error?: unknown): void {
    if (!processingConfig.ai.adaptiveEnabled) {
      return;
    }

    const st = this.state[capability];

    st.window.push(ok);
    if (st.window.length > processingConfig.ai.adaptiveWindowSize) {
      st.window.shift();
    }

    if (ok) {
      st.consecutiveFailures = 0;
      st.consecutiveSuccesses++;
    } else {
      st.consecutiveFailures++;
      st.consecutiveSuccesses = 0;
    }

    const now = this.nowFn();
    if (now - st.lastAdjustedAt < processingConfig.ai.adaptiveCooldownMs) {
      return;
    }

    const windowSize = st.window.length;
    const failures = st.window.filter((v) => !v).length;
    const failureRate = windowSize > 0 ? failures / windowSize : 0;

    const shouldDegrade =
      st.consecutiveFailures >= processingConfig.ai.adaptiveConsecutiveFailureThreshold ||
      (windowSize >= Math.min(5, processingConfig.ai.adaptiveWindowSize) &&
        failureRate >= processingConfig.ai.adaptiveFailureRateThreshold);

    if (shouldDegrade) {
      // Multiplicative Decrease
      const min = Math.max(1, Math.floor(processingConfig.ai.adaptiveMinConcurrency));
      const next = Math.max(min, Math.floor(st.current / 2));

      if (next < st.current) {
        const prev = st.current;
        st.current = next;
        st.lastAdjustedAt = now;
        st.window = [];
        st.consecutiveFailures = 0;
        st.consecutiveSuccesses = 0;

        this.semaphores.setLimit(capability, next);

        this.logger.warn(
          {
            capability,
            prev,
            next,
            failureRate,
            error: error instanceof Error ? error.message : error ? String(error) : undefined,
          },
          "Adaptive concurrency degraded"
        );
      }
      return;
    }

    if (
      st.current < st.base &&
      st.consecutiveSuccesses >= processingConfig.ai.adaptiveRecoverySuccessThreshold
    ) {
      // Additive Increase
      const step = Math.max(1, Math.floor(processingConfig.ai.adaptiveRecoveryStep));
      const next = Math.min(st.base, st.current + step);

      if (next > st.current) {
        const prev = st.current;
        st.current = next;
        st.lastAdjustedAt = now;
        st.window = [];
        st.consecutiveFailures = 0;
        st.consecutiveSuccesses = 0;

        this.semaphores.setLimit(capability, next);
        this.logger.info({ capability, prev, next }, "Adaptive concurrency recovered");
      }
    }
  }
}

/**
 * Control callbacks for breaker to manage capture.
 *
 * - `stop`: Called when breaker trips (typically stops screen capture)
 * - `start`: Called when breaker allows auto-recovery after config fix (typically resumes screen capture)
 * - `getState`: Optional, used to determine if auto-recovery should happen (e.g., was running/paused/idle)
 */
type CaptureControlCallbacks = {
  stop: () => Promise<void>;
  start: () => Promise<void>;
  getState: () => Pick<CaptureSchedulerState, "status">;
};

/**
 * Records failure events within the circuit breaker window.
 *
 * Breaker logic only depends on: timestamp + event count (threshold), no complex classification.
 */
interface FailureEvent {
  ts: number;
  capability: AICapability;
  message: string;
  name?: string;
}

/**
 * AIFailureCircuitBreaker.
 *
 * Goal: When AI fails continuously (usually provider unavailable/config error/network issues),
 * quickly stop screen capture to avoid meaningless continued screenshots and more AI calls.
 *
 * Mechanism:
 * - Maintains failure events within a fixed time window (`windowMs`)
 * - Trips when failures in window >= `threshold`
 * - After tripped:
 *   - Calls captureControlCallbacks.stop()
 *   - Broadcasts IPC event (for UI notification)
 *   - Waits for user to save config, optional auto resume after validate success
 */
class AIFailureCircuitBreaker {
  private readonly logger = getLogger("ai-failure-circuit-breaker");

  private readonly nowFn: () => number;
  private readonly windowMs = 10 * 1000;
  private readonly threshold = 3;

  private readonly validateConfig: (config: LLMConfig) => Promise<{ success: boolean }>;
  private readonly sendToAllWindows: (payload: AIFailureFuseTrippedPayload) => void;

  /** Failure records within circuit breaker window (trimmed by windowMs) */
  private events: FailureEvent[] = [];

  /** Whether breaker has tripped */
  private tripped = false;

  /**
   * Whether to auto-start capture on recovery.
   *
   * Determined by getState() at trip time.
   */
  private shouldAutoResumeCapture = false;

  /** Control callbacks registered by ScreenCaptureModule (avoids circular dependency) */
  private captureControlCallbacks: CaptureControlCallbacks | null = null;

  constructor(args: {
    nowFn: () => number;
    validateConfig: (config: LLMConfig) => Promise<{ success: boolean }>;
    sendToAllWindows: (payload: AIFailureFuseTrippedPayload) => void;
  }) {
    this.nowFn = args.nowFn;
    this.validateConfig = args.validateConfig;
    this.sendToAllWindows = args.sendToAllWindows;
  }

  registerCaptureControlCallbacks(callbacks: CaptureControlCallbacks): void {
    this.captureControlCallbacks = callbacks;
  }

  /**
   * Records a failure.
   *
   * Note: Does not distinguish failure types/recoverability, only checks "failure count in short window".
   */
  recordFailure(capability: AICapability, err: unknown): void {
    const now = this.nowFn();
    const e = err instanceof Error ? err : new Error(String(err));

    this.events.push({
      ts: now,
      capability,
      message: e.message,
      name: e.name,
    });

    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }

    this.logger.debug(
      { capability, eventCount: this.events.length, tripped: this.tripped },
      "Recorded AI failure"
    );

    if (!this.tripped && this.events.length >= this.threshold) {
      this.trip(this.events[this.events.length - 1]);
    }
  }

  /** Manually reset breaker (e.g., when user clicks restart capture or reinitialize) */
  reset(): void {
    this.logger.info("Resetting circuit breaker");
    this.events = [];
    this.tripped = false;
    this.shouldAutoResumeCapture = false;
  }

  isTripped(): boolean {
    return this.tripped;
  }

  private trip(last: FailureEvent): void {
    this.tripped = true;

    this.logger.warn(
      { eventCount: this.events.length, lastCapability: last.capability },
      "Circuit breaker tripped - stopping screen capture"
    );

    const currentStatus = this.captureControlCallbacks?.getState?.()?.status;
    this.shouldAutoResumeCapture =
      currentStatus === "running" || currentStatus === "paused" || currentStatus === "idle";

    if (this.captureControlCallbacks?.stop) {
      try {
        void this.captureControlCallbacks.stop();
      } catch (error) {
        this.logger.error({ error }, "Failed to stop screen capture during circuit trip");
      }
    }

    const payload: AIFailureFuseTrippedPayload = {
      windowMs: this.windowMs,
      threshold: this.threshold,
      count: this.events.length,
      last: {
        capability: last.capability,
        message: last.message,
      },
    };

    this.sendToAllWindows(payload);

    try {
      aiRuntimeEventBus.emit("ai-fuse:tripped", {
        type: "ai-fuse:tripped",
        timestamp: Date.now(),
        payload,
      });
    } catch {
      // ignore
    }
  }

  /**
   * Attempts recovery after user saves config.
   *
   * Design:
   * - Only triggers when tripped
   * - After validate success: if capture state allows auto-recovery, call start()
   * - Finally reset() to clear breaker state and window
   */
  async handleConfigSaved(config: LLMConfig): Promise<void> {
    if (!this.tripped) return;

    this.logger.info("Config saved - validating for circuit recovery");

    try {
      const result = await this.validateConfig(config);

      if (result.success) {
        this.logger.info("LLM configuration validated successfully - resuming capture");

        if (this.shouldAutoResumeCapture && this.captureControlCallbacks?.start) {
          try {
            await this.captureControlCallbacks.start();
          } catch (error) {
            this.logger.error({ error }, "Failed to restart screen capture after recovery");
          }
        }

        this.reset();
      }
    } catch (error) {
      this.logger.error({ error }, "Error during recovery attempt");
    }
  }
}

// =========================================================================
// Runtime Service
// =========================================================================

/**
 * AIRuntimeService (unified runtime service).
 *
 * This is the only external entry point (exported via `aiRuntimeService` singleton).
 * Purpose: Unifies "concurrency control + adaptive concurrency tuning + failure circuit breaker"
 * in one place to avoid inconsistent strategies across modules.
 *
 * External API:
 * - `acquire(capability)`: Acquire permit (returns release() callback)
 * - `recordSuccess(capability)`: Record success (for tuner to recover concurrency)
 * - `recordFailure(capability, err, { tripBreaker })`: Record failure (for tuner to degrade; optionally trip breaker)
 * - `registerCaptureControlCallbacks(...)`: Registered by ScreenCaptureModule
 * - `handleConfigSaved(config)`: Called by llm-config-handlers after config save
 * - `isTripped()/resetBreaker()`: Breaker state management
 */
class AIRuntimeService {
  private readonly semaphores: AISemaphoreManager;
  private readonly tuner: AIConcurrencyTuner;
  private readonly breaker: AIFailureCircuitBreaker;

  constructor(args?: {
    nowFn?: () => number;
    validateConfig?: (config: LLMConfig) => Promise<{ success: boolean }>;
    sendToAllWindows?: (payload: AIFailureFuseTrippedPayload) => void;
  }) {
    const nowFn = args?.nowFn ?? Date.now;

    const sendToAllWindows = args?.sendToAllWindows ?? defaultSendToAllWindows;
    const validateConfig = args?.validateConfig ?? defaultValidateConfig;

    this.semaphores = new AISemaphoreManager();
    this.tuner = new AIConcurrencyTuner({
      nowFn,
      semaphores: this.semaphores,
    });
    this.breaker = new AIFailureCircuitBreaker({ nowFn, validateConfig, sendToAllWindows });
  }

  acquire(capability: AICapability): Promise<() => void> {
    return this.semaphores.acquire(capability);
  }

  /** Read current concurrency limit (from semaphore.limit) */
  getLimit(capability: AICapability): number {
    return this.semaphores.getLimit(capability);
  }

  recordSuccess(capability: AICapability): void {
    this.tuner.recordSuccess(capability);
  }

  /**
   * Records failure:
   * - Always goes through tuner (for degrading concurrency)
   * - Also goes through breaker by default (for tripping), but can be disabled via `tripBreaker:false`
   *
   * Typical usage:
   * - deep-search / activity-monitor: failures shouldn't affect capture => tripBreaker:false
   * - screenshot processing pipeline: failures may indicate provider/config issues => default tripBreaker:true
   */
  recordFailure(capability: AICapability, err: unknown, options?: { tripBreaker?: boolean }): void {
    this.tuner.recordFailure(capability, err);

    const tripBreaker = options?.tripBreaker ?? true;
    if (tripBreaker) {
      this.breaker.recordFailure(capability, err);
    }
  }

  registerCaptureControlCallbacks(callbacks: CaptureControlCallbacks): void {
    this.breaker.registerCaptureControlCallbacks(callbacks);
  }

  handleConfigSaved(config: LLMConfig): Promise<void> {
    return this.breaker.handleConfigSaved(config);
  }

  isTripped(): boolean {
    return this.breaker.isTripped();
  }

  resetBreaker(): void {
    this.breaker.reset();
  }
}

export const aiRuntimeService = new AIRuntimeService();

/**
 * Test entry point: prevents business code from depending on internal classes.
 *
 * Business code should only depend on `aiRuntimeService`.
 */
export const __testing = {
  Semaphore,
  AIRuntimeService,
};
