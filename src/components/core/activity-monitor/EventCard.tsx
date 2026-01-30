import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { Clock, Zap, Code, Users, Coffee, Globe, Focus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ActivityEvent } from "./types";
import { cn } from "@/lib/utils";

interface EventCardProps {
  event: ActivityEvent;
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

export function EventCard({ event }: EventCardProps) {
  const { t } = useTranslation();

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
        className={cn("px-4 py-3.5 relative z-10")}
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
                  "text-base font-semibold leading-snug tracking-tight",
                  event.isLong ? "text-amber-950 dark:text-amber-100" : "text-foreground"
                )}
              >
                {event.title}
              </h4>
              {event.isLong && (
                <Badge
                  variant="secondary"
                  className="text-sm px-2 py-0 rounded-sm font-semibold bg-amber-500 text-white border-none shadow-sm whitespace-nowrap shrink-0 mt-0.5"
                >
                  {t("activityMonitor.event.longEvent")}
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground/80">
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
        </div>
      </motion.div>

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
