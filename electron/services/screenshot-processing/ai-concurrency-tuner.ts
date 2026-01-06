import { getLogger } from "../logger";
import { aiConcurrencyConfig } from "./config";
import { aiSemaphore } from "./ai-semaphore";

export type AICapability = "vlm" | "text" | "embedding";

type CapabilityState = {
  base: number;
  current: number;
  window: boolean[];
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastAdjustedAt: number;
};

const logger = getLogger("ai-concurrency-tuner");

export class AIConcurrencyTuner {
  private state: Record<AICapability, CapabilityState>;

  constructor() {
    const now = Date.now();
    this.state = {
      vlm: this.makeState(aiConcurrencyConfig.vlmGlobalConcurrency, now),
      text: this.makeState(aiConcurrencyConfig.textGlobalConcurrency, now),
      embedding: this.makeState(aiConcurrencyConfig.embeddingGlobalConcurrency, now),
    };

    aiSemaphore.setLimit("vlm", this.state.vlm.current);
    aiSemaphore.setLimit("text", this.state.text.current);
    aiSemaphore.setLimit("embedding", this.state.embedding.current);
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
    if (!aiConcurrencyConfig.adaptiveEnabled) {
      return;
    }

    const st = this.state[capability];

    st.window.push(ok);
    if (st.window.length > aiConcurrencyConfig.adaptiveWindowSize) {
      st.window.shift();
    }

    if (ok) {
      st.consecutiveFailures = 0;
      st.consecutiveSuccesses++;
    } else {
      st.consecutiveFailures++;
      st.consecutiveSuccesses = 0;
    }

    const now = Date.now();
    if (now - st.lastAdjustedAt < aiConcurrencyConfig.adaptiveCooldownMs) {
      return;
    }

    const windowSize = st.window.length;
    const failures = st.window.filter((v) => !v).length;
    const failureRate = windowSize > 0 ? failures / windowSize : 0;

    const shouldDegrade =
      st.consecutiveFailures >= aiConcurrencyConfig.adaptiveConsecutiveFailureThreshold ||
      (windowSize >= Math.min(5, aiConcurrencyConfig.adaptiveWindowSize) &&
        failureRate >= aiConcurrencyConfig.adaptiveFailureRateThreshold);

    if (shouldDegrade) {
      const min = Math.max(1, Math.floor(aiConcurrencyConfig.adaptiveMinConcurrency));
      const next = Math.max(min, Math.floor(st.current / 2));
      if (next < st.current) {
        const prev = st.current;
        st.current = next;
        st.lastAdjustedAt = now;
        st.window = [];
        st.consecutiveFailures = 0;
        st.consecutiveSuccesses = 0;
        aiSemaphore.setLimit(capability, next);
        logger.warn(
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
      st.consecutiveSuccesses >= aiConcurrencyConfig.adaptiveRecoverySuccessThreshold
    ) {
      const step = Math.max(1, Math.floor(aiConcurrencyConfig.adaptiveRecoveryStep));
      const next = Math.min(st.base, st.current + step);
      if (next > st.current) {
        const prev = st.current;
        st.current = next;
        st.lastAdjustedAt = now;
        st.window = [];
        st.consecutiveFailures = 0;
        st.consecutiveSuccesses = 0;
        aiSemaphore.setLimit(capability, next);
        logger.info({ capability, prev, next }, "Adaptive concurrency recovered");
      }
    }
  }
}

export const aiConcurrencyTuner = new AIConcurrencyTuner();
