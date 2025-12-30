import { useState, useEffect, useCallback } from "react";
import type { UsageSummaryResult, UsageBreakdownItem, UsageDailyItem } from "@shared/ipc-types";

// Default to 30 days ago
const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

export function useUsageStats() {
  const [summary, setSummary] = useState<UsageSummaryResult | null>(null);
  const [breakdown, setBreakdown] = useState<UsageBreakdownItem[]>([]);
  const [dailyUsage, setDailyUsage] = useState<UsageDailyItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const now = Date.now();
      const fromTs = now - DEFAULT_RANGE_MS;
      const range = { fromTs, toTs: now };

      // Parallel fetch
      const [summaryResult, breakdownResult, dailyResult] = await Promise.all([
        window.usageApi.getSummary(range),
        window.usageApi.getBreakdown(range),
        window.usageApi.getDaily(range),
      ]);

      if (summaryResult.success && summaryResult.data) {
        setSummary(summaryResult.data);
      } else if (summaryResult.error) {
        console.error("Failed to fetch summary:", summaryResult.error);
      }

      if (breakdownResult.success && breakdownResult.data) {
        setBreakdown(breakdownResult.data);
      }

      if (dailyResult.success && dailyResult.data) {
        setDailyUsage(dailyResult.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      console.error("Error fetching usage stats:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    summary,
    breakdown,
    dailyUsage,
    isLoading,
    error,
    refresh: fetchData,
  };
}
