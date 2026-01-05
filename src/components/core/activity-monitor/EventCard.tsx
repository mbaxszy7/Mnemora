import { Suspense, lazy, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Zap,
  Code,
  Users,
  Coffee,
  Globe,
  Focus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ActivityEvent } from "./types";
import { cn } from "@/lib/utils";

const MarkdownContent = lazy(() =>
  import("./MarkdownContent").then((m) => ({
    default: m.MarkdownContent,
  }))
);

function MarkdownSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-8/12" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-10/12" />
        <Skeleton className="h-3 w-9/12" />
      </div>
      <Skeleton className="h-20 w-full rounded-md" />
      <Skeleton className="h-3 w-7/12" />
    </div>
  );
}

interface EventCardProps {
  event: ActivityEvent;
  onFetchDetails?: (eventId: number) => Promise<ActivityEvent | null>;
}

// Event kind icons and colors
const kindConfig = {
  coding: {
    icon: Code,
    color: "bg-blue-500/10 text-blue-500",
    labelKey: "activityMonitor.event.kinds.coding",
  },
  meeting: {
    icon: Users,
    color: "bg-purple-500/10 text-purple-500",
    labelKey: "activityMonitor.event.kinds.meeting",
  },
  break: {
    icon: Coffee,
    color: "bg-green-500/10 text-green-500",
    labelKey: "activityMonitor.event.kinds.break",
  },
  browse: {
    icon: Globe,
    color: "bg-sky-500/10 text-sky-500",
    labelKey: "activityMonitor.event.kinds.browse",
  },
  focus: {
    icon: Focus,
    color: "bg-amber-500/10 text-amber-500",
    labelKey: "activityMonitor.event.kinds.focus",
  },
  work: {
    icon: Zap,
    color: "bg-orange-500/10 text-orange-500",
    labelKey: "activityMonitor.event.kinds.work",
  },
} as const;

export function EventCard({ event, onFetchDetails }: EventCardProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [localDetails, setLocalDetails] = useState<string | null>(event.details);
  const [isFetching, setIsFetching] = useState(false);

  const startTime = format(new Date(event.startTs), "HH:mm");
  const endTime = format(new Date(event.endTs), "HH:mm");
  const durationMinutes = Math.round(event.durationMs / 60000);
  const durationText =
    durationMinutes >= 60
      ? t("activityMonitor.event.durationHM", {
          h: Math.floor(durationMinutes / 60),
          m: durationMinutes % 60,
        })
      : t("activityMonitor.event.durationM", { m: durationMinutes });

  interface KindStyle {
    icon: React.ElementType;
    color: string;
    labelKey:
      | "activityMonitor.event.kinds.coding"
      | "activityMonitor.event.kinds.meeting"
      | "activityMonitor.event.kinds.break"
      | "activityMonitor.event.kinds.browse"
      | "activityMonitor.event.kinds.focus"
      | "activityMonitor.event.kinds.work";
  }
  const config =
    (kindConfig as unknown as Record<string, KindStyle>)[event.kind] || kindConfig.work;
  const KindIcon = config.icon;

  const handleExpand = async () => {
    if (!event.isLong) return;

    if (!isExpanded && !localDetails && onFetchDetails) {
      setIsFetching(true);
      try {
        const result = await onFetchDetails(event.id);
        if (result && result.details) {
          setLocalDetails(result.details);
        }
      } finally {
        setIsFetching(false);
      }
    }

    setIsExpanded(!isExpanded);
  };

  return (
    <motion.div
      layout
      className={`
        rounded-lg border overflow-hidden
        ${event.isLong ? "border-amber-500/30 bg-amber-500/5" : "border-border/50 bg-card/50"}
      `}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Header */}
      <motion.div
        className={cn("px-4 py-3 ", event.isLong ? "cursor-pointer" : "")}
        onClick={handleExpand}
        whileHover={{ backgroundColor: "hsl(var(--secondary) / 0.3)" }}
        transition={{ duration: 0.15 }}
      >
        <div className="flex items-start gap-3">
          {/* Kind icon */}
          <div className={`p-2 rounded-lg ${config.color}`}>
            <KindIcon className="h-4 w-4" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-sm font-medium truncate">{event.title}</h4>
              {event.isLong && (
                <Badge
                  variant="outline"
                  className="text-xs border-amber-500/50 text-amber-600 dark:text-amber-400"
                >
                  {t("activityMonitor.event.longEvent")}
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {startTime} - {endTime}
              </span>
              <span className="font-medium">{durationText}</span>
              <Badge variant="secondary" className="text-xs">
                {t(config.labelKey)}
              </Badge>
            </div>
          </div>

          {/* Expand button for long events */}
          {event.isLong && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                handleExpand();
              }}
            >
              <motion.div animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </motion.div>
            </Button>
          )}
        </div>
      </motion.div>

      {/* Expandable details */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-2 border-t border-border/30">
              {isFetching ? (
                <div className="py-8 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
                  <span className="text-xs">{t("common.messages.loading")}</span>
                </div>
              ) : localDetails ? (
                <Suspense fallback={<MarkdownSkeleton />}>
                  <MarkdownContent content={localDetails} variant="compact" />
                </Suspense>
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground italic">
                  {t("activityMonitor.event.noDetails")}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Importance/confidence indicators */}
      {event.importance >= 7 && (
        <motion.div
          className="h-0.5 bg-linear-to-r from-amber-500 to-orange-500"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ delay: 0.2, duration: 0.3 }}
        />
      )}
    </motion.div>
  );
}
