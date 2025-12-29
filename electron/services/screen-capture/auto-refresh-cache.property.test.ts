import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { AutoRefreshCache } from "./auto-refresh-cache";

describe("AutoRefreshCache Property Tests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Property 3: Cache refresh updates data - after refresh, cache contains the fetched data", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate arbitrary data that could be cached
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.array(fc.integer()),
          fc.record({ id: fc.uuid(), value: fc.string() })
        ),
        async (testData) => {
          // Create a fetch function that returns the test data
          const fetchFn = vi.fn().mockResolvedValue(testData);

          const cache = new AutoRefreshCache({
            fetchFn,
            interval: 10000, // Long interval to prevent auto-refresh during test
            immediate: false, // Don't fetch immediately
          });

          try {
            // Manually trigger refresh
            const result = await cache.refresh();

            // Property: The returned data should equal the test data
            expect(result).toEqual(testData);

            // Property: The cached data should equal the test data
            expect(cache.get()).toEqual(testData);

            // Property: hasData should return true
            expect(cache.hasData()).toBe(true);

            // Property: lastRefreshTime should be set
            expect(cache.getLastRefreshTime()).not.toBeNull();

            return true;
          } finally {
            cache.dispose();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 4: Cache error resilience - on fetch error, previous data is retained", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate initial data
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.array(fc.integer()),
          fc.record({ id: fc.uuid(), value: fc.string() })
        ),
        // Generate error message
        fc.string({ minLength: 1 }),
        async (initialData, errorMessage) => {
          let callCount = 0;
          const onError = vi.fn();

          // Fetch function that succeeds first, then fails
          const fetchFn = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve(initialData);
            }
            return Promise.reject(new Error(errorMessage));
          });

          const cache = new AutoRefreshCache({
            fetchFn,
            interval: 10000,
            immediate: false,
            onError,
          });

          try {
            // First refresh should succeed
            await cache.refresh();
            expect(cache.get()).toEqual(initialData);

            const lastRefreshTimeBefore = cache.getLastRefreshTime();

            // Second refresh should fail but retain data
            const result = await cache.refresh();

            // Property: The cached data should still equal the initial data
            expect(cache.get()).toEqual(initialData);

            // Property: The returned data should be the previous cached data
            expect(result).toEqual(initialData);

            // Property: onError should have been called
            expect(onError).toHaveBeenCalled();

            // Property: lastRefreshTime should not have changed (since refresh failed)
            // Note: In our implementation, lastRefreshTime only updates on success
            expect(cache.getLastRefreshTime()).toBe(lastRefreshTimeBefore);

            return true;
          } finally {
            cache.dispose();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
