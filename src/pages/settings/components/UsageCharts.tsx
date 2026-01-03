import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import type { UsageDailyItem } from "@shared/ipc-types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface UsageChartsProps {
  data: UsageDailyItem[];
  isLoading: boolean;
}

export function UsageCharts({ data, isLoading }: UsageChartsProps) {
  const { t } = useTranslation();
  const chartData = useMemo(() => {
    return data.map((item) => ({
      name: item.date,
      Total: item.totalTokens,
    }));
  }, [data]);

  if (isLoading) {
    return <Skeleton className="w-full h-[300px] rounded-lg" />;
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("usage.charts.dailyTokenUsage", "Daily Token Usage")}</CardTitle>
          <CardDescription>
            {t(
              "usage.charts.noDataDescription",
              "No usage data available for the selected period."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="h-[300px] flex items-center justify-center text-muted-foreground">
          {t("usage.charts.noData", "No data")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("usage.charts.dailyTokenUsage", "Daily Token Usage")}</CardTitle>
        <CardDescription>
          {t("usage.charts.description", "Total token usage over time")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{
                top: 20,
                right: 30,
                left: 20,
                bottom: 5,
              }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="name" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `${value}`}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: "8px",
                  border: "none",
                  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                }}
                cursor={{ fill: "transparent" }}
              />
              <Legend />
              <Bar dataKey="Total" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
