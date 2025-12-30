import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { UsageBreakdownItem } from "@shared/ipc-types";

interface UsageBreakdownProps {
  data: UsageBreakdownItem[];
  isLoading: boolean;
}

export function UsageBreakdown({ data, isLoading }: UsageBreakdownProps) {
  const { t } = useTranslation();

  if (isLoading) {
    return <Skeleton className="w-full h-[200px] rounded-lg" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("usage.breakdown.title", "Usage Breakdown")}</CardTitle>
        <CardDescription>Usage statistics by model and capability</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("usage.breakdown.table.model", "Model")}</TableHead>
              <TableHead>{t("usage.breakdown.table.capability", "Capability")}</TableHead>
              <TableHead className="text-right">
                {t("usage.breakdown.table.requests", "Requests")}
              </TableHead>
              <TableHead className="text-right">Succeeded</TableHead>
              <TableHead className="text-right">
                {t("usage.breakdown.table.tokens", "Total Tokens")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground h-24">
                  No data available
                </TableCell>
              </TableRow>
            ) : (
              data.map((item, index) => (
                <TableRow key={`${item.model}-${item.capability}-${index}`}>
                  <TableCell className="font-medium">{item.model}</TableCell>
                  <TableCell className="capitalize">{item.capability}</TableCell>
                  <TableCell className="text-right">{item.requestCount}</TableCell>
                  <TableCell className="text-right">{item.succeededCount}</TableCell>
                  <TableCell className="text-right">{item.totalTokens.toLocaleString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
