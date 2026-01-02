import { motion } from "framer-motion";
import { format } from "date-fns";
import type { TimeWindow } from "./types";

interface TimelineBlockProps {
  window: TimeWindow;
  isSelected: boolean;
  hasLongEvent?: boolean;
  onClick: () => void;
}

// App icon color mapping
const appColors: Record<string, string> = {
  "VS Code": "bg-blue-500",
  Chrome: "bg-green-500",
  Arc: "bg-pink-500",
  Terminal: "bg-gray-600",
  Slack: "bg-purple-500",
  Zoom: "bg-blue-400",
  Notion: "bg-gray-800 dark:bg-gray-200",
  Figma: "bg-orange-500",
  Spotify: "bg-green-600",
  "GitHub Desktop": "bg-gray-700",
  Twitter: "bg-sky-500",
};

export function TimelineBlock({ window, isSelected, hasLongEvent, onClick }: TimelineBlockProps) {
  const startTime = format(new Date(window.windowStart), "HH:mm");
  const endTime = format(new Date(window.windowEnd), "HH:mm");

  return (
    <motion.div
      layout
      onClick={onClick}
      className={`
        relative cursor-pointer rounded-lg p-3 mb-2
        transition-colors duration-200
        ${
          isSelected
            ? "bg-primary/10 border border-primary/30"
            : "bg-card hover:bg-secondary/80 border border-transparent"
        }
      `}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ scale: 1.01, x: 2 }}
      whileTap={{ scale: 0.99 }}
      transition={{ duration: 0.15 }}
    >
      {/* Long event indicator */}
      {hasLongEvent && (
        <motion.div
          className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-amber-500 rounded-r-full"
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ delay: 0.1, duration: 0.2 }}
        />
      )}

      {/* Time range */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {startTime} - {endTime}
        </span>
        {isSelected && (
          <motion.div
            className="w-1.5 h-1.5 rounded-full bg-primary"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
          />
        )}
      </div>

      {/* Title */}
      <h4 className="text-sm font-medium mb-2 line-clamp-1">{window.title}</h4>

      {/* App indicators */}
      <div className="flex items-center gap-1.5 min-h-[20px]">
        {window.stats?.topApps.slice(0, 3).map((app, i) => (
          <motion.div
            key={app}
            className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold text-white ${
              appColors[app] || "bg-gray-500"
            }`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.05 }}
            title={app}
          >
            {app.charAt(0)}
          </motion.div>
        ))}
        {(window.stats?.topApps.length ?? 0) > 3 && (
          <span className="text-xs text-muted-foreground">
            +{(window.stats?.topApps.length ?? 0) - 3}
          </span>
        )}
      </div>
    </motion.div>
  );
}
