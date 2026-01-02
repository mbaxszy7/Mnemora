import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";
import { FileText, Sparkles, BarChart3 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { EventCard } from "./EventCard";
import { MarkdownContent } from "./MarkdownContent";
import type { WindowSummary, ActivityEvent } from "./types";

interface SummaryPanelProps {
  summary: WindowSummary | null;
  onFetchDetails?: (eventId: number) => Promise<ActivityEvent | null>;
}

export function SummaryPanel({ summary, onFetchDetails }: SummaryPanelProps) {
  const { t } = useTranslation();

  if (!summary) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-card/50 rounded-xl border border-border/50">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
        >
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

  const startTime = format(new Date(summary.windowStart), "HH:mm");
  const endTime = format(new Date(summary.windowEnd), "HH:mm");
  const dateStr = format(new Date(summary.windowStart), "MM/dd");

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={summary.windowStart}
        className="h-full flex flex-col bg-card/50 rounded-xl border border-border/50 overflow-hidden"
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
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
            <motion.div
              className="flex flex-wrap gap-2 mt-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              {summary.highlights?.map((highlight, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2 + i * 0.05 }}
                >
                  <Badge variant="secondary" className="text-xs font-normal py-1">
                    <Sparkles className="h-3 w-3 mr-1" />
                    {highlight}
                  </Badge>
                </motion.div>
              ))}
            </motion.div>
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
                <span className="text-sm">{summary.stats?.nodeCount ?? 0} 个节点</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50">
                <span className="text-sm">{summary.stats?.screenshotCount ?? 0} 张截图</span>
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
              <MarkdownContent content={summary.summary} />
            </motion.div>

            {/* Events section */}
            {summary.events.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  {t("activityMonitor.summary.relatedEvents")}
                </h3>
                <div className="space-y-3">
                  {summary.events.map((event, i) => (
                    <motion.div
                      key={event.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.35 + i * 0.05 }}
                    >
                      <EventCard event={event} onFetchDetails={onFetchDetails} />
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </div>
        </ScrollArea>
      </motion.div>
    </AnimatePresence>
  );
}
