/**
 * AI Semaphore
 *
 * Provides global concurrency control for AI API calls.
 * Prevents overwhelming the provider with too many concurrent requests.
 */

import { aiConcurrencyConfig } from "./config";

/**
 * A counting semaphore for limiting concurrent access
 */
export class Semaphore {
  private permits: number;
  private limit: number;
  private inUse: number;
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

    this.limit = next;
    this.permits = Math.max(0, this.limit - this.inUse);

    while (this.permits > 0 && this.waiting.length > 0) {
      const nextWaiter = this.waiting.shift();
      if (!nextWaiter) break;
      nextWaiter();
    }
  }

  /**
   * Acquire a permit, waiting if necessary until one is available.
   * Returns a release function that must be called when done.
   */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      this.inUse++;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.permits--;
        this.inUse++;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    if (this.inUse > 0) {
      this.inUse--;
    }
    this.permits++;
    if (this.permits > this.limit - this.inUse) {
      this.permits = Math.max(0, this.limit - this.inUse);
    }
    const next = this.waiting.shift();
    if (next) {
      next();
    }
  }
}

/**
 * Global AI semaphores for controlling concurrent API calls.
 * Each capability (VLM, Text, Embedding) has its own semaphore.
 */
class AISemaphoreManager {
  private _vlm: Semaphore | null = null;
  private _text: Semaphore | null = null;
  private _embedding: Semaphore | null = null;

  private ensure(capability: "vlm" | "text" | "embedding"): Semaphore {
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
      this._vlm = new Semaphore(aiConcurrencyConfig.vlmGlobalConcurrency);
    }
    return this._vlm;
  }

  get text(): Semaphore {
    if (!this._text) {
      this._text = new Semaphore(aiConcurrencyConfig.textGlobalConcurrency);
    }
    return this._text;
  }

  get embedding(): Semaphore {
    if (!this._embedding) {
      this._embedding = new Semaphore(aiConcurrencyConfig.embeddingGlobalConcurrency);
    }
    return this._embedding;
  }

  getLimit(capability: "vlm" | "text" | "embedding"): number {
    return this.ensure(capability).getLimit();
  }

  setLimit(capability: "vlm" | "text" | "embedding", limit: number): void {
    this.ensure(capability).setLimit(limit);
  }

  /**
   * Backward compatible accessor for a capability semaphore.
   */
  get(capability: "vlm" | "text" | "embedding"): Semaphore {
    return this.ensure(capability);
  }
}

export const aiSemaphore = new AISemaphoreManager();
