import { Suspense, lazy, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";
import { ChevronDown, Clock, Zap, Code, Users, Coffee, Globe, Focus } from "lucide-react";
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
  const [loadingPhase, setLoadingPhase] = useState<"preparing" | "analyzing" | "drafting">(
    "preparing"
  );

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

    // Toggle expand state
    const willExpand = !isExpanded;
    setIsExpanded(willExpand);

    // If expanding and no details yet, fetch them
    if (willExpand && !localDetails && onFetchDetails) {
      setIsFetching(true);
      setLoadingPhase("preparing");

      // Rotate loading phases
      const phaseTimer = setInterval(() => {
        setLoadingPhase((current) => {
          if (current === "preparing") return "analyzing";
          if (current === "analyzing") return "drafting";
          return "drafting";
        });
      }, 3500);

      try {
        const result = await onFetchDetails(event.id);
        if (result && result.details) {
          setLocalDetails(result.details);
        }
      } finally {
        clearInterval(phaseTimer);
        setIsFetching(false);
      }
    }
  };

  return (
    <motion.div
      layout
      className={cn(
        "group relative rounded-lg border transition-all duration-300 overflow-hidden",
        event.isLong
          ? "border-amber-500/40 bg-amber-500/10 shadow-sm"
          : "border-border/50 bg-card/40 hover:bg-card/60"
      )}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Header */}
      <motion.div
        className={cn("px-4 py-3.5 relative z-10", event.isLong ? "cursor-pointer" : "")}
        onClick={handleExpand}
        whileHover={{ backgroundColor: "hsl(var(--secondary) / 0.2)" }}
        transition={{ duration: 0.2 }}
      >
        <div className="flex items-start gap-3">
          {/* Kind icon */}
          <div
            className={cn(
              "p-2 rounded-md transition-transform group-hover:scale-105",
              config.color
            )}
          >
            <KindIcon className="h-4 w-4" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <h4
                className={cn(
                  "text-[14px] font-semibold leading-snug tracking-tight",
                  event.isLong ? "text-amber-950 dark:text-amber-100" : "text-foreground"
                )}
              >
                {event.title}
              </h4>
              {event.isLong && (
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 rounded-sm font-bold bg-amber-500 text-white border-none shadow-sm whitespace-nowrap shrink-0 mt-0.5"
                >
                  {t("activityMonitor.event.longEvent")}
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground/80">
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-background/50 border border-border/30">
                <Clock className="h-3 w-3" />
                {startTime} - {endTime}
              </span>
              <span className="font-semibold text-foreground/70">{durationText}</span>
              <div className="h-1 w-1 rounded-full bg-muted-foreground/30" />
              <span className="font-medium tracking-wide uppercase opacity-70">
                {t(config.labelKey)}
              </span>
            </div>
          </div>

          {/* Expand button for long events */}
          {event.isLong && (
            <div className="flex items-center self-center pl-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full hover:bg-amber-500/20 text-amber-600 dark:text-amber-400"
                onClick={(e) => {
                  e.stopPropagation();
                  handleExpand();
                }}
              >
                <motion.div
                  animate={{ rotate: isExpanded ? 180 : 0 }}
                  transition={{ duration: 0.3, type: "spring", stiffness: 300, damping: 20 }}
                >
                  <ChevronDown className="h-4 w-4" />
                </motion.div>
              </Button>
            </div>
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
                <div className="py-10 flex flex-col items-center justify-center gap-4">
                  <div className="relative">
                    <motion.div
                      className="h-10 w-10 rounded-full border-t-2 border-primary"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    />
                    <motion.div
                      className="absolute inset-0 h-10 w-10 rounded-full border-2 border-primary/20"
                      initial={{ scale: 0.8, opacity: 0.5 }}
                      animate={{ scale: 1.2, opacity: 0 }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
                    />
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={loadingPhase}
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                        className="text-xs font-medium text-primary/80"
                      >
                        {loadingPhase === "preparing"
                          ? t("activityMonitor.event.loading.preparing")
                          : loadingPhase === "analyzing"
                            ? t("activityMonitor.event.loading.analyzing")
                            : t("activityMonitor.event.loading.drafting")}
                      </motion.span>
                    </AnimatePresence>
                    <span className="text-[10px] text-muted-foreground animate-pulse">
                      {t("common.messages.loading")}
                    </span>
                  </div>
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

      {/* Importance line */}
      {event.importance >= 7 && (
        <motion.div
          className="absolute bottom-0 left-0 right-0 h-[3px] bg-linear-to-r from-amber-500 via-orange-500 to-amber-500"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ delay: 0.2, duration: 0.6, ease: "easeOut" }}
          style={{ transformOrigin: "left" }}
        />
      )}
    </motion.div>
  );
}
