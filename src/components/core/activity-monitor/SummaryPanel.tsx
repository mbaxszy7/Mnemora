import { Suspense, lazy, useState } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";
import { FileText, Highlighter, BarChart3, ChevronDown, ChevronUp } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EventCard } from "./EventCard";
import type { WindowSummary } from "./types";

const MarkdownContent = lazy(() =>
  import("./MarkdownContent").then((m) => ({
    default: m.MarkdownContent,
  }))
);

function MarkdownSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-5 w-7/12" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-9/12" />
      </div>
      <Skeleton className="h-32 w-full rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-9/12" />
        <Skeleton className="h-4 w-8/12" />
      </div>
    </div>
  );
}

interface SummaryPanelProps {
  summary: WindowSummary | null;
  isLoading?: boolean;
  variants?: Variants;
}

export function SummaryPanel({ summary, isLoading, variants }: SummaryPanelProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Return early if no summary and not loading
  if (!summary && !isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-card/50 rounded-xl border border-border/50">
        <motion.div variants={variants}>
          <FileText className="h-16 w-16 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium text-muted-foreground mb-2">
            {t("activityMonitor.summary.selectWindow")}
          </h3>
          <p className="text-sm text-muted-foreground/70">
            {t("activityMonitor.summary.selectWindowDescription")}
          </p>
        </motion.div>
      </div>
    );
  }

  // Pre-calculate date strings if summary exists
  const startTime = summary ? format(new Date(summary.windowStart), "HH:mm") : "";
  const endTime = summary ? format(new Date(summary.windowEnd), "HH:mm") : "";
  const dateStr = summary
    ? format(new Date(summary.windowStart), t("common.dateFormats.shortDate"))
    : "";

  const filteredEvents = (() => {
    if (!summary) return [];
    const longThreadIds = new Set(
      summary.events.filter((e) => e.isLong && e.threadId).map((e) => e.threadId as string)
    );

    return summary.events.filter((e) => {
      if (e.isLong) return true;
      if (!e.threadId) return true;
      return !longThreadIds.has(e.threadId);
    });
  })();

  return (
    <div className="relative h-full overflow-hidden rounded-xl border border-border/50 bg-card/50">
      <AnimatePresence mode="wait">
        {isLoading && !summary ? (
          <motion.div
            key="loading"
            className="h-full flex flex-col items-center justify-center p-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </motion.div>
        ) : summary ? (
          <motion.div
            key={summary.windowStart}
            className="h-full flex flex-col overflow-hidden"
            variants={variants}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-border/50">
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <span className="font-medium">
                    {dateStr} {startTime} - {endTime}
                  </span>
                </div>
                <h2 className="text-xl font-semibold">{summary.title}</h2>
              </motion.div>

              {/* Highlights */}
              {(summary.highlights?.length ?? 0) > 0 && (
                <div className="mt-3">
                  <div className="flex flex-wrap gap-2">
                    {/* First highlight - always visible */}
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.2 }}
                    >
                      <Badge variant="secondary" className="text-xs font-normal py-1">
                        <Highlighter className="h-3 w-3 mr-1" />
                        {summary.highlights![0]}
                      </Badge>
                    </motion.div>

                    {/* Expand/Collapse Toggle */}
                    {summary.highlights!.length > 1 && (
                      <motion.button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="flex items-center"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.3 }}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                      >
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase tracking-wider font-semibold py-0.5 px-1.5 opacity-60 hover:opacity-100 transition-opacity cursor-pointer flex items-center gap-1"
                        >
                          {isExpanded ? (
                            <>
                              {t("common.actions.showLess")}
                              <ChevronUp className="h-2.5 w-2.5" />
                            </>
                          ) : (
                            <>
                              {t("common.actions.moreCount", {
                                count: summary.highlights!.length - 1,
                              })}
                              <ChevronDown className="h-2.5 w-2.5" />
                            </>
                          )}
                        </Badge>
                      </motion.button>
                    )}
                  </div>

                  {/* Additional Highlights */}
                  <AnimatePresence>
                    {isExpanded && summary.highlights!.length > 1 && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        className="overflow-hidden"
                      >
                        <div className="flex flex-wrap gap-2 pt-2">
                          {summary.highlights!.slice(1).map((highlight, i) => (
                            <motion.div
                              key={i}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: i * 0.05 }}
                            >
                              <Badge variant="secondary" className="text-xs font-normal py-1">
                                <Highlighter className="h-3 w-3 mr-1" />
                                {highlight}
                              </Badge>
                            </motion.div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>

            {/* Content */}
            <ScrollArea className="flex-1">
              <div className="px-5 py-4 space-y-6">
                {/* Stats */}
                <motion.div
                  className="flex items-center gap-4"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 }}
                >
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50">
                    <BarChart3 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      {t("activityMonitor.summary.nodes", { count: summary.stats?.nodeCount ?? 0 })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50">
                    <span className="text-sm">
                      {t("activityMonitor.summary.screenshots", {
                        count: summary.stats?.screenshotCount ?? 0,
                      })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {summary.stats?.topApps.slice(0, 3).map((app) => (
                      <Badge key={app} variant="outline" className="text-xs">
                        {app}
                      </Badge>
                    ))}
                  </div>
                </motion.div>

                {/* Summary content */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                >
                  <Suspense fallback={<MarkdownSkeleton />}>
                    <MarkdownContent content={summary.summary} />
                  </Suspense>
                </motion.div>

                {/* Events section */}
                {filteredEvents.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                  >
                    <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
                      <Highlighter className="h-4 w-4 text-amber-500" />
                      {t("activityMonitor.summary.relatedEvents")}
                    </h3>
                    <div className="space-y-3">
                      {filteredEvents.map((event, i) => (
                        <motion.div
                          key={event.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.35 + i * 0.05 }}
                        >
                          <EventCard event={event} />
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </div>
            </ScrollArea>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Loading overlay when refreshing existing summary */}
      {isLoading && summary && (
        <motion.div
          className="absolute inset-0 bg-background/20 backdrop-blur-[1px] flex items-center justify-center z-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="bg-card/80 p-2 rounded-full shadow-lg border border-border/50">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
          </div>
        </motion.div>
      )}
    </div>
  );
}
