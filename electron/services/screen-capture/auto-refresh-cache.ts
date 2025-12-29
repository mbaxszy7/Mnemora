/**
 * AutoRefreshCache - Generic cache with automatic refresh at configurable intervals
 */

import { AutoRefreshCacheOptions, DEFAULT_CACHE_INTERVAL } from "./types";
import { getLogger } from "../logger";

const logger = getLogger("auto-refresh-cache");

export interface IAutoRefreshCache<T> {
  get(): T | null;
  refresh(): Promise<T>;
  hasData(): boolean;
  getLastRefreshTime(): number | null;
  dispose(): void;
}

export class AutoRefreshCache<T> implements IAutoRefreshCache<T> {
  private cachedData: T | null = null;
  private lastRefreshTime: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly fetchFn: () => Promise<T>;
  private readonly interval: number;
  private readonly onError?: (error: Error) => void;

  constructor(options: AutoRefreshCacheOptions<T>) {
    this.fetchFn = options.fetchFn;
    this.interval = options.interval ?? DEFAULT_CACHE_INTERVAL;
    this.onError = options.onError;

    if (options.immediate !== false) {
      // Start the initial fetch and schedule the refresh loop
      // Use .finally() to ensure refresh loop starts even if initial fetch fails
      this.doRefresh()
        .catch(() => {
          // Error already logged in doRefresh, just swallow it here
        })
        .finally(() => {
          if (!this.disposed) {
            this.scheduleNextRefresh();
          }
        });
    } else {
      // Just schedule the refresh loop without immediate fetch
      this.scheduleNextRefresh();
    }
  }

  get(): T | null {
    return this.cachedData;
  }

  async refresh(): Promise<T> {
    return this.doRefresh();
  }

  hasData(): boolean {
    return this.cachedData !== null;
  }

  getLastRefreshTime(): number | null {
    return this.lastRefreshTime;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /** Perform fetch and update cache. Retains previous data on error. */
  private async doRefresh(): Promise<T> {
    try {
      logger.debug("Starting cache refresh");
      const data = await this.fetchFn();
      // Update cache with fresh data
      this.cachedData = data;
      this.lastRefreshTime = Date.now();
      logger.debug(
        { dataLength: Array.isArray(data) ? data.length : "N/A" },
        "Cache refresh completed"
      );
      return data;
    } catch (error) {
      logger.error({ error }, "Cache refresh failed");
      if (this.onError) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
      // If we have no previous data, rethrow the error
      if (this.cachedData === null) {
        throw error;
      }
      // Return the previous cached data
      return this.cachedData;
    }
  }

  private scheduleNextRefresh(): void {
    if (this.disposed) {
      return;
    }

    this.timerId = setTimeout(async () => {
      if (this.disposed) {
        return;
      }

      await this.doRefresh();

      // Schedule the next refresh after this one completes
      this.scheduleNextRefresh();
    }, this.interval);
  }
}
