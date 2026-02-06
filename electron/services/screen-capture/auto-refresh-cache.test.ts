import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoRefreshCache } from "./auto-refresh-cache";

describe("AutoRefreshCache Unit Tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Immediate fetch on construction", () => {
    it("should fetch immediately when immediate is true (default)", async () => {
      const testData = { id: 1, name: "test" };
      const fetchFn = vi.fn().mockResolvedValue(testData);

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: true,
      });

      // Let the immediate fetch complete (flush microtasks)
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cache.get()).toEqual(testData);

      cache.dispose();
    });

    it("should not fetch immediately when immediate is false", async () => {
      const fetchFn = vi.fn().mockResolvedValue("data");

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: false,
      });

      // No immediate fetch should have occurred
      expect(fetchFn).not.toHaveBeenCalled();
      expect(cache.get()).toBeNull();

      cache.dispose();
    });
  });

  describe("Dispose stops refresh cycle", () => {
    it("should stop refresh cycle when disposed", async () => {
      const fetchFn = vi.fn().mockResolvedValue("data");

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 1000,
        immediate: false,
      });

      // Dispose immediately
      cache.dispose();

      // Advance time past the interval
      await vi.advanceTimersByTimeAsync(5000);

      // Fetch should never have been called
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("should stop scheduled refreshes after dispose", async () => {
      const fetchFn = vi.fn().mockResolvedValue("data");

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 1000,
        immediate: true,
      });

      // Let initial fetch complete (flush microtasks)
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Dispose
      cache.dispose();

      // Advance time - no more fetches should occur
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Synchronous get returns cached data", () => {
    it("should return null when no data has been fetched", () => {
      const fetchFn = vi.fn().mockResolvedValue("data");

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: false,
      });

      expect(cache.get()).toBeNull();
      expect(cache.hasData()).toBe(false);

      cache.dispose();
    });

    it("should return cached data synchronously after fetch", async () => {
      const testData = { value: 42 };
      const fetchFn = vi.fn().mockResolvedValue(testData);

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: true,
      });

      // Let the fetch complete (flush microtasks)
      await vi.advanceTimersByTimeAsync(0);

      // Synchronous access should return the data
      const result = cache.get();
      expect(result).toEqual(testData);
      expect(cache.hasData()).toBe(true);

      cache.dispose();
    });

    it("should update cached data on refresh interval", async () => {
      let counter = 0;
      const fetchFn = vi.fn().mockImplementation(() => {
        counter++;
        return Promise.resolve({ count: counter });
      });

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 1000,
        immediate: true,
      });

      // Initial fetch (flush microtasks)
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.get()).toEqual({ count: 1 });

      // Advance to trigger refresh
      await vi.advanceTimersByTimeAsync(1000);
      expect(cache.get()).toEqual({ count: 2 });

      cache.dispose();
    });
  });

  describe("getLastRefreshTime", () => {
    it("should return null before any refresh", () => {
      const fetchFn = vi.fn().mockResolvedValue("data");

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: false,
      });

      expect(cache.getLastRefreshTime()).toBeNull();

      cache.dispose();
    });

    it("should return timestamp after successful refresh", async () => {
      const fetchFn = vi.fn().mockResolvedValue("data");
      const now = Date.now();
      vi.setSystemTime(now);

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: true,
      });

      // Let the fetch complete (flush microtasks)
      await vi.advanceTimersByTimeAsync(0);

      expect(cache.getLastRefreshTime()).toBe(now);

      cache.dispose();
    });
  });

  describe("Manual refresh", () => {
    it("should allow manual refresh via refresh() method", async () => {
      const fetchFn = vi.fn().mockResolvedValue("data");

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 10000,
        immediate: false,
      });

      expect(cache.get()).toBeNull();

      // Manual refresh
      await cache.refresh();

      expect(cache.get()).toBe("data");
      expect(fetchFn).toHaveBeenCalledTimes(1);

      cache.dispose();
    });
  });

  describe("Error handling", () => {
    it("should call onError callback when fetch fails", async () => {
      const onError = vi.fn();
      const fetchFn = vi.fn().mockRejectedValue(new Error("fetch failed"));

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: true,
        onError,
      });

      // Let the initial fetch fail
      await vi.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0][0].message).toBe("fetch failed");

      cache.dispose();
    });

    it("should rethrow error when fetch fails with no cached data", async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error("fetch failed"));

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: false,
      });

      await expect(cache.refresh()).rejects.toThrow("fetch failed");

      cache.dispose();
    });

    it("should return stale data when fetch fails with existing cached data", async () => {
      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve("original");
        return Promise.reject(new Error("fetch failed"));
      });

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 1000,
        immediate: true,
      });

      // Initial success
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.get()).toBe("original");

      // Second fetch fails - should return stale data
      const result = await cache.refresh();
      expect(result).toBe("original");

      cache.dispose();
    });

    it("should wrap non-Error objects in onError callback", async () => {
      const onError = vi.fn();
      const fetchFn = vi.fn().mockRejectedValue("string error");

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: false,
        onError,
      });

      await cache.refresh().catch(() => {});

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0][0].message).toBe("string error");

      cache.dispose();
    });

    it("should continue refresh cycle after fetch error", async () => {
      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve("data");
        if (callCount === 2) return Promise.reject(new Error("fail"));
        return Promise.resolve("recovered");
      });

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 1000,
        immediate: true,
      });

      // Initial fetch succeeds
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.get()).toBe("data");

      // Second fetch fails
      await vi.advanceTimersByTimeAsync(1000);
      expect(cache.get()).toBe("data"); // stale

      // Third fetch recovers
      await vi.advanceTimersByTimeAsync(1000);
      expect(cache.get()).toBe("recovered");

      cache.dispose();
    });

    it("should handle fetch returning array data", async () => {
      const fetchFn = vi.fn().mockResolvedValue([1, 2, 3]);

      const cache = new AutoRefreshCache({
        fetchFn,
        interval: 3000,
        immediate: true,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(cache.get()).toEqual([1, 2, 3]);

      cache.dispose();
    });
  });
});
