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
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    if (permits <= 0) {
      throw new Error("Semaphore permits must be positive");
    }
    this.permits = permits;
  }

  /**
   * Acquire a permit, waiting if necessary until one is available.
   * Returns a release function that must be called when done.
   */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.permits--;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.permits++;
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

  /**
   * Get semaphore for a specific capability
   */
  get(capability: "vlm" | "text" | "embedding"): Semaphore {
    switch (capability) {
      case "vlm":
        return this.vlm;
      case "text":
        return this.text;
      case "embedding":
        return this.embedding;
    }
  }
}

export const aiSemaphore = new AISemaphoreManager();
