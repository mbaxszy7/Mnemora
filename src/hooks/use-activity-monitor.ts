import { useState, useEffect, useCallback, useRef } from "react";
import type {
  TimeWindow,
  LongEventMarker,
  WindowSummary,
  ActivityEvent,
  ActivityTimelineChangedPayload,
} from "@shared/activity-types";

/**
 * Global cache to persist activity data across component remounts
 * (e.g. when navigating to Settings and back, or window restore)
 */
const globalCache = {
  windows: new Map<number, TimeWindow>(),
  longEvents: new Map<number, LongEventMarker>(),
  rangeMs: 24 * 60 * 60 * 1000,
  lastRevision: 0,
  hasLoadedOnce: false,
};

export function useActivityMonitor() {
  // Initialize from global cache if available
  // Note: Data from backend is already sorted (newest first)
  const [timeline, setTimeline] = useState<TimeWindow[]>(() => {
    return Array.from(globalCache.windows.values()).sort((a, b) => b.windowStart - a.windowStart);
  });
  const [longEvents, setLongEvents] = useState<LongEventMarker[]>(() => {
    return Array.from(globalCache.longEvents.values()).sort((a, b) => b.startTs - a.startTs);
  });

  // Only show initial loading if we've never loaded before
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(!globalCache.hasLoadedOnce);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadedRangeMs, setLoadedRangeMs] = useState<number>(globalCache.rangeMs);
  const cacheRangeMsRef = useRef<number>(globalCache.rangeMs);
  const [cacheRangeMs, setCacheRangeMs] = useState<number>(globalCache.rangeMs);
  const [cacheRevision, setCacheRevision] = useState(0);

  const refreshTimerRef = useRef<number | null>(null);
  const lastRevisionRef = useRef<number>(globalCache.lastRevision);
  const latestLoadedRangeRef = useRef<number>(loadedRangeMs);

  useEffect(() => {
    latestLoadedRangeRef.current = loadedRangeMs;
  }, [loadedRangeMs]);

  const mergeIntoCache = useCallback(
    (data: { windows: TimeWindow[]; longEvents: LongEventMarker[] }) => {
      for (const w of data.windows) {
        globalCache.windows.set(w.id, w);
      }
      for (const e of data.longEvents) {
        globalCache.longEvents.set(e.id, e);
      }
      globalCache.hasLoadedOnce = true;
      setCacheRevision((x) => x + 1);
    },
    []
  );

  const fetchTimeline = useCallback(
    async (opts?: { rangeMs?: number; merge?: boolean; markLoading?: boolean }) => {
      const rangeMs = opts?.rangeMs ?? latestLoadedRangeRef.current;
      const merge = opts?.merge ?? false;
      const markLoading = opts?.markLoading ?? true;

      if (markLoading) {
        if (merge) setIsLoadingMore(true);
        else setIsLoadingTimeline(true);
      }

      setError(null);

      try {
        const now = Date.now();
        const fromTs = now - rangeMs;
        const result = await window.activityMonitorApi.getTimeline({ fromTs, toTs: now });

        if (result.success && result.data) {
          globalCache.rangeMs = Math.max(globalCache.rangeMs, rangeMs);
          cacheRangeMsRef.current = globalCache.rangeMs;
          setCacheRangeMs(globalCache.rangeMs);
          mergeIntoCache(result.data);
        } else {
          setError(result.error?.message || "Failed to fetch timeline");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (markLoading) {
          if (merge) setIsLoadingMore(false);
          else setIsLoadingTimeline(false);
        }
      }
    },
    [mergeIntoCache]
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void fetchTimeline({
        rangeMs: latestLoadedRangeRef.current,
        merge: false,
        markLoading: false,
      });
    }, 350);
  }, [fetchTimeline]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  const loadMore = useCallback(
    async (target: "6h" | "24h") => {
      const targetRangeMs = target === "6h" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

      const current = latestLoadedRangeRef.current;
      if (targetRangeMs <= current) {
        return;
      }

      setLoadedRangeMs(targetRangeMs);

      if (targetRangeMs <= cacheRangeMsRef.current) {
        return;
      }

      await fetchTimeline({ rangeMs: targetRangeMs, merge: true, markLoading: true });
    },
    [fetchTimeline]
  );

  useEffect(() => {
    const now = Date.now();
    const effectiveRangeMs = Math.min(loadedRangeMs, cacheRangeMs);
    const fromTs = now - effectiveRangeMs;

    // Filter cache items and sort descending (newest first)
    // Map.values() preserves insertion order, so we must sort after merging new items.
    const windows = Array.from(globalCache.windows.values())
      .filter((w) => w.windowEnd > fromTs && w.windowStart < now)
      .sort((a, b) => b.windowStart - a.windowStart);

    const events = Array.from(globalCache.longEvents.values())
      .filter((e) => e.startTs < now && e.endTs > fromTs)
      .sort((a, b) => b.startTs - a.startTs);

    setTimeline(windows);
    setLongEvents(events);
  }, [cacheRevision, loadedRangeMs, cacheRangeMs]);

  // Fetch summary for a specific window
  const getSummary = useCallback(
    async (start: number, end: number): Promise<WindowSummary | null> => {
      try {
        const result = await window.activityMonitorApi.getSummary({
          windowStart: start,
          windowEnd: end,
        });
        if (result.success && result.data) {
          return result.data;
        }
        return null;
      } catch (err) {
        console.error("Failed to fetch summary:", err);
        return null;
      }
    },
    []
  );

  // Fetch event details
  const getEventDetails = useCallback(async (eventId: number): Promise<ActivityEvent | null> => {
    console.log("Fetching event details for eventId:", eventId);
    try {
      const result = await window.activityMonitorApi.getEventDetails({ eventId });
      if (result.success && result.data) {
        return result.data;
      }
      return null;
    } catch (err) {
      console.error("Failed to fetch event details:", err);
      return null;
    }
  }, []);

  // Initial load or refresh if already loaded
  useEffect(() => {
    void fetchTimeline({
      rangeMs: globalCache.rangeMs,
      merge: false,
      markLoading: !globalCache.hasLoadedOnce,
    });
  }, [fetchTimeline]);

  // Subscribe to main-process timeline change notifications
  useEffect(() => {
    const unsubscribe = window.activityMonitorApi.onTimelineChanged(
      (payload: ActivityTimelineChangedPayload) => {
        if (payload.revision <= globalCache.lastRevision) return;
        globalCache.lastRevision = payload.revision;
        lastRevisionRef.current = payload.revision;
        scheduleRefresh();
      }
    );
    return () => unsubscribe();
  }, [scheduleRefresh]);

  useEffect(() => {
    const handleFocus = () => {
      scheduleRefresh();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        scheduleRefresh();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [scheduleRefresh]);

  const effectiveLoadedRangeMs = Math.min(loadedRangeMs, cacheRangeMs);

  return {
    timeline,
    longEvents,
    isLoadingTimeline,
    isLoadingMore,
    error,
    fetchTimeline,
    loadedRangeMs: effectiveLoadedRangeMs,
    loadMore,
    getSummary,
    getEventDetails,
  };
}
