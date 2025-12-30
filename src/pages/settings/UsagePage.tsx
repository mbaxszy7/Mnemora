import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useViewTransition } from "@/components/core/view-transition";
import { UsageCharts } from "./components/UsageCharts";
import { UsageBreakdown } from "./components/UsageBreakdown";
import { useUsageStats } from "./hooks/useUsageStats";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function UsagePage() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();
  const { summary, breakdown, dailyUsage, isLoading, refresh } = useUsageStats();

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-10">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/settings", { type: "slide-right", duration: 300 })}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold">{t("usage.title", "Usage Statistics")}</h1>
          <p className="text-muted-foreground mt-1">
            {t("usage.description", "Track your LLM token usage and costs")}
          </p>
        </div>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            {t("usage.refresh", "Refresh")}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              {t("usage.summary.totalTokens", "Total Tokens")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.totalTokens.toLocaleString() ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {t("usage.summary.last30Days", "Last 30 days")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              {t("usage.summary.totalRequests", "Total Requests")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.requestCount.toLocaleString() ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      <UsageCharts data={dailyUsage} isLoading={isLoading} />
      <UsageBreakdown data={breakdown} isLoading={isLoading} />
    </div>
  );
}
