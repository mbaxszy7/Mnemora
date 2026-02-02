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
 * AI 能力类型（贯穿 semaphore/tuner/breaker 以及所有调用点）。
 *
 * - `vlm`: 视觉模型相关（截图理解/分片分析等）
 * - `text`: 纯文本 LLM（summary、deep search、merge hint 等）
 * - `embedding`: 向量化（写入/更新向量索引）
 */
export type AICapability = "vlm" | "text" | "embedding";

const runtimeLogger = getLogger("ai-runtime-service");

/**
 * breaker 熔断时的默认广播实现：向所有 BrowserWindow 发送 IPC 事件。
 *
 * 设计要点：
 * - 放在模块级，避免 `AIRuntimeService` 构造时创建闭包/绑定 `this`
 * - 单元测试可通过依赖注入替换为 mock
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
 * breaker 恢复时的默认配置校验实现。
 *
 * breaker tripped 后：
 * - 等待用户保存配置（LLM_CONFIG_SAVE）
 * - 调用 validate，成功才允许自动恢复 capture
 */
async function defaultValidateConfig(config: LLMConfig): Promise<{ success: boolean }> {
  const res = await LLMConfigService.getInstance().validateConfiguration(config);
  return { success: res.success };
}

// =========================================================================
// Semaphore
// =========================================================================

/**
 * 一个简单的计数信号量（counting semaphore）。
 *
 * 目的：
 * - 为不同 AI capability 提供“全局并发上限”，避免同时发起过多请求
 * - 支持动态调整并发（`setLimit`），用于自适应 tuner
 *
 * 关键字段：
 * - `limit`: 当前允许的最大并发（上限）
 * - `inUse`: 当前已经被 acquire 的 permit 数（正在占用的并发数）
 * - `permits`: 当前仍可用的 permit 数（可立即 acquire 的数量）
 * - `waiting`: 等待队列（FIFO）。当 `permits` 变为正数时按顺序唤醒。
 */
class Semaphore {
  /** 可用 permit 数（可立即 acquire 的数量） */
  private permits: number;

  /** 并发上限（最大同时 inUse） */
  private limit: number;

  /** 已占用 permit 数（正在并发中的任务数量） */
  private inUse: number;

  /**
   * 等待队列（FIFO）。当有空余 permit 时，会 shift 出队并唤醒。
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

    // 调整上限后，重新计算“可用 permit”。
    // 注意：当 limit 降到 < inUse 时，可用 permit 会变成 0（表示没有 capacity）。
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
        // 只有在被唤醒时才会真正占用 permit。
        // 被唤醒的前提：release/setLimit 确认当前有 capacity。
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
   * 每个 capability 一个 semaphore。
   *
   * 设计选择：lazy init（按需创建）。
   * - 避免主进程启动时无意义初始化
   * - 也减少测试里不必要的副作用
   */
  private _vlm: Semaphore | null = null;
  private _text: Semaphore | null = null;
  private _embedding: Semaphore | null = null;

  /**
   * 根据 capability 返回对应的 semaphore。
   *
   * 设计要点：
   * - 这里统一路由，保证调用方只关心 capability，不关心具体实例
   * - 内部通过 getter 保证 lazy init
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

  /** 获取指定 capability 的 permit（调用方拿到 release() 回调后必须确保最终调用） */
  acquire(capability: AICapability): Promise<() => void> {
    return this.ensure(capability).acquire();
  }

  /** 返回当前 semaphore 的并发上限（limit） */
  getLimit(capability: AICapability): number {
    return this.ensure(capability).getLimit();
  }

  /** 设置当前 semaphore 的并发上限（供 tuner 动态调整） */
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
  /** 初始并发上限（通常来自 processingConfig.ai.*GlobalConcurrency） */
  base: number;

  /** 当前并发上限（会被 degrade/recover 调整） */
  current: number;

  /** 滑动窗口：true=success / false=failure，用于计算 failure rate */
  window: boolean[];

  /** 连续失败次数（用于快速触发降级） */
  consecutiveFailures: number;

  /** 连续成功次数（用于触发恢复） */
  consecutiveSuccesses: number;

  /** 上一次调整并发的时间戳，用于 cooldown */
  lastAdjustedAt: number;
};

/**
 * Adaptive Concurrency Tuner（自适应并发调节器）。
 *
 * 目标：在 AI 请求稳定时逐步恢复到 base 并发；当失败变多时快速降级并发，
 * 从而降低错误雪崩与 provider 限流风险。
 *
 * 机制概览：
 * - 维护一个 success/failure 滑动窗口 + 连续成功/失败计数
 * - 每次 record 后，在 cooldown 允许时判断是否需要降级/恢复
 * - 降级：current /= 2（下限为 adaptiveMinConcurrency）
 * - 恢复：current += adaptiveRecoveryStep，直到 base
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
 * breaker 对 capture 的控制回调。
 *
 * - `stop`: breaker 熔断时调用（通常停止截图）
 * - `start`: breaker 在“配置修复且允许自动恢复”时调用（通常恢复截图）
 * - `getState`: 可选，用于判断是否应该自动恢复（比如当时是 running/paused/idle）
 */
type CaptureControlCallbacks = {
  stop: () => Promise<void>;
  start: () => Promise<void>;
  getState: () => Pick<CaptureSchedulerState, "status">;
};

/**
 * 记录熔断窗口内的失败事件。
 *
 * breaker 的判断逻辑只依赖：时间戳 + event 数量（阈值），不做复杂分类。
 */
interface FailureEvent {
  ts: number;
  capability: AICapability;
  message: string;
  name?: string;
}

/**
 * AIFailureCircuitBreaker（失败熔断器）。
 *
 * 目标：当 AI 连续失败（通常是 provider 不可用/配置错误/网络问题）时，
 * 快速停止 screen capture，避免无意义地继续截图并触发更多 AI 调用。
 *
 * 机制：
 * - 维护一个固定时间窗口（`windowMs`）内的失败 events
 * - 当窗口内失败数 >= `threshold` 时 tripped
 * - tripped 后：
 *   - 调用 captureControlCallbacks.stop()
 *   - 广播 IPC 事件（用于 UI 提示）
 *   - 等待用户保存配置，validate 成功后可选 auto resume
 */
class AIFailureCircuitBreaker {
  private readonly logger = getLogger("ai-failure-circuit-breaker");

  private readonly nowFn: () => number;
  private readonly windowMs = 10 * 1000;
  private readonly threshold = 3;

  private readonly validateConfig: (config: LLMConfig) => Promise<{ success: boolean }>;
  private readonly sendToAllWindows: (payload: AIFailureFuseTrippedPayload) => void;

  /** 熔断窗口内的失败记录（会按 windowMs 滚动裁剪） */
  private events: FailureEvent[] = [];

  /** breaker 是否已 tripped */
  private tripped = false;

  /**
   * 是否应该在恢复时自动 start capture。
   *
   * 该值在 trip 时根据 getState() 判断。
   */
  private shouldAutoResumeCapture = false;

  /** ScreenCaptureModule 注册的控制回调（避免直接依赖导致循环引用） */
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
   * 记录一次失败。
   *
   * 注意：这里并不区分失败类型/可恢复性，只做“短窗口内失败数量”判断。
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

  /** 手动重置 breaker（例如用户点击重新开始 capture 或重新初始化时） */
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
   * 在用户保存配置后尝试恢复。
   *
   * 设计：
   * - 只在 tripped 状态下触发
   * - validate 成功后：如果当时 capture 状态允许自动恢复，则调用 start()
   * - 最后 reset()，清空熔断状态与窗口
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
 * AIRuntimeService（统一运行时服务）。
 *
 * 这是对外的唯一入口（通过 `aiRuntimeService` 单例导出）。
 * 目的：把“并发控制 + 自适应并发调节 + 失败熔断”统一在一处，避免不同模块
 * 各自实现导致策略不一致。
 *
 * 对外 API：
 * - `acquire(capability)`: 获取 permit（返回 release() 回调）
 * - `recordSuccess(capability)`: 记录成功（用于 tuner 恢复并发）
 * - `recordFailure(capability, err, { tripBreaker })`: 记录失败（用于 tuner 降级；可选触发 breaker）
 * - `registerCaptureControlCallbacks(...)`: 由 ScreenCaptureModule 注册
 * - `handleConfigSaved(config)`: 由 llm-config-handlers 在保存配置后调用
 * - `isTripped()/resetBreaker()`: breaker 状态管理
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

  /** 读取当前并发上限（底层来自 semaphore.limit） */
  getLimit(capability: AICapability): number {
    return this.semaphores.getLimit(capability);
  }

  recordSuccess(capability: AICapability): void {
    this.tuner.recordSuccess(capability);
  }

  /**
   * 记录失败：
   * - 一定会走 tuner（用于降级并发）
   * - 默认也会走 breaker（用于熔断），但可通过 `tripBreaker:false` 关闭
   *
   * 典型用法：
   * - deep-search / activity-monitor：失败不应影响 capture => tripBreaker:false
   * - screenshot processing pipeline：失败可能反映 provider/配置问题 => 默认 tripBreaker:true
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
 * 测试入口：避免业务代码依赖内部 class。
 *
 * 业务侧请只依赖 `aiRuntimeService`。
 */
export const __testing = {
  Semaphore,
  AIRuntimeService,
};
