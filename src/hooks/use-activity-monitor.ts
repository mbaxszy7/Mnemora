import { useState, useEffect, useCallback, useRef } from "react";
import type {
  TimeWindow,
  LongEventMarker,
  WindowSummary,
  ActivityEvent,
  ActivityTimelineChangedPayload,
} from "@shared/activity-types";

export function useActivityMonitor() {
  const [timeline, setTimeline] = useState<TimeWindow[]>([]);
  const [longEvents, setLongEvents] = useState<LongEventMarker[]>([]);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadedRangeMs, setLoadedRangeMs] = useState<number>(2 * 60 * 60 * 1000);
  const cacheRangeMsRef = useRef<number>(2 * 60 * 60 * 1000);
  const [cacheRangeMs, setCacheRangeMs] = useState<number>(2 * 60 * 60 * 1000);
  const cacheWindowsRef = useRef<Map<number, TimeWindow>>(new Map());
  const cacheLongEventsRef = useRef<Map<number, LongEventMarker>>(new Map());
  const [cacheRevision, setCacheRevision] = useState(0);

  const refreshTimerRef = useRef<number | null>(null);
  const lastRevisionRef = useRef<number>(0);
  const latestLoadedRangeRef = useRef<number>(loadedRangeMs);
  useEffect(() => {
    latestLoadedRangeRef.current = loadedRangeMs;
  }, [loadedRangeMs]);

  const mergeIntoCache = useCallback(
    (data: { windows: TimeWindow[]; longEvents: LongEventMarker[] }) => {
      for (const w of data.windows) {
        cacheWindowsRef.current.set(w.id, w);
      }
      for (const e of data.longEvents) {
        cacheLongEventsRef.current.set(e.id, e);
      }
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
          cacheRangeMsRef.current = Math.max(cacheRangeMsRef.current, rangeMs);
          setCacheRangeMs(cacheRangeMsRef.current);
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

    const windows = Array.from(cacheWindowsRef.current.values())
      .filter((w) => w.windowEnd > fromTs && w.windowStart < now)
      .sort((a, b) => a.windowStart - b.windowStart);

    const events = Array.from(cacheLongEventsRef.current.values())
      .filter((e) => e.startTs < now && e.endTs > fromTs)
      .sort((a, b) => a.startTs - b.startTs);

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

  // Initial load (2h)
  useEffect(() => {
    void fetchTimeline({ rangeMs: 2 * 60 * 60 * 1000, merge: false, markLoading: true });
    setLoadedRangeMs(2 * 60 * 60 * 1000);
  }, [fetchTimeline]);

  // Idle prefetch to 24h (non-blocking)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (cacheRangeMsRef.current < 24 * 60 * 60 * 1000) {
        void fetchTimeline({ rangeMs: 24 * 60 * 60 * 1000, merge: true, markLoading: false });
      }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [fetchTimeline]);

  // Subscribe to main-process timeline change notifications
  useEffect(() => {
    const unsubscribe = window.activityMonitorApi.onTimelineChanged(
      (payload: ActivityTimelineChangedPayload) => {
        if (payload.revision <= lastRevisionRef.current) return;
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
