import { useMemo } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { Clock, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TimelineBlock } from "./TimelineBlock";
import type { TimeWindow, LongEventMarker } from "./types";

function heapPush(heap: number[], value: number) {
  heap.push(value);
  let idx = heap.length - 1;
  while (idx > 0) {
    const parent = Math.floor((idx - 1) / 2);
    if (heap[parent] <= heap[idx]) break;
    const tmp = heap[parent];
    heap[parent] = heap[idx];
    heap[idx] = tmp;
    idx = parent;
  }
}

function heapPeek(heap: number[]): number | undefined {
  return heap[0];
}

function heapPop(heap: number[]): number | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0) return top;
  heap[0] = last;
  let idx = 0;
  while (true) {
    const left = idx * 2 + 1;
    const right = idx * 2 + 2;
    let smallest = idx;
    if (left < heap.length && heap[left] < heap[smallest]) smallest = left;
    if (right < heap.length && heap[right] < heap[smallest]) smallest = right;
    if (smallest === idx) break;
    const tmp = heap[smallest];
    heap[smallest] = heap[idx];
    heap[idx] = tmp;
    idx = smallest;
  }
  return top;
}

interface TimelineProps {
  windows: TimeWindow[];
  events: LongEventMarker[];
  selectedWindowId: number | string | null;
  onSelectWindow: (windowId: number | string) => void;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  loadedRangeMs?: number;
  onLoadMore?: (target: "6h" | "24h") => void;
  variants?: Variants;
}

export function Timeline({
  windows,
  events,
  selectedWindowId,
  onSelectWindow,
  isLoading,
  isLoadingMore,
  loadedRangeMs,
  onLoadMore,
  variants,
}: TimelineProps) {
  const { t } = useTranslation();
  // Pre-compute which windows have long events
  const windowsWithLongEvents = useMemo(() => {
    const longEventWindows = new Set<number | string>();

    const windowsSorted = [...windows].sort((a, b) => a.windowStart - b.windowStart);
    const eventsSorted = [...events].sort((a, b) => a.startTs - b.startTs);

    const activeEndHeap: number[] = [];
    let eventIdx = 0;

    for (const w of windowsSorted) {
      while (eventIdx < eventsSorted.length && eventsSorted[eventIdx].startTs < w.windowEnd) {
        heapPush(activeEndHeap, eventsSorted[eventIdx].endTs);
        eventIdx += 1;
      }

      while (activeEndHeap.length > 0 && (heapPeek(activeEndHeap) ?? 0) <= w.windowStart) {
        heapPop(activeEndHeap);
      }

      if (activeEndHeap.length > 0) {
        longEventWindows.add(w.id);
      }
    }

    return longEventWindows;
  }, [windows, events]);

  // Get current date for header
  const today = format(new Date(), t("common.dateFormats.fullDate"));

  const loadedLabel =
    loadedRangeMs && loadedRangeMs >= 24 * 60 * 60 * 1000
      ? t("activityMonitor.timeline.range24h")
      : loadedRangeMs && loadedRangeMs >= 6 * 60 * 60 * 1000
        ? t("activityMonitor.timeline.range6h")
        : t("activityMonitor.timeline.range2h");

  const rangeText = isLoadingMore
    ? loadedRangeMs && loadedRangeMs >= 6 * 60 * 60 * 1000
      ? t("activityMonitor.timeline.loadingTo24h")
      : loadedRangeMs && loadedRangeMs >= 2 * 60 * 60 * 1000
        ? t("activityMonitor.timeline.loadingTo6h")
        : t("activityMonitor.timeline.loadingGeneric")
    : t("activityMonitor.timeline.loadedRecent", { label: loadedLabel });

  // Animation variants for staggered children
  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.03,
        delayChildren: 0.1,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, x: -10 },
    show: { opacity: 1, x: 0 },
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <motion.div className="flex items-center gap-2 px-4 py-3" variants={variants}>
        <Clock className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{t("activityMonitor.timeline.title")}</h3>
        <span className="text-xs text-muted-foreground ml-auto">{today}</span>
      </motion.div>

      {/* Timeline blocks */}
      <ScrollArea className="flex-1 px-3 py-2">
        <AnimatePresence mode="wait">
          {isLoading && windows.length === 0 ? (
            <motion.div
              key="loading"
              variants={containerVariants}
              initial="hidden"
              animate="show"
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              className="space-y-2"
            >
              {Array.from({ length: 8 }).map((_, idx) => (
                <motion.div
                  key={idx}
                  variants={itemVariants}
                  className="rounded-lg border border-border/60 bg-card p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-2.5 w-2.5 rounded-full" />
                  </div>
                  <Skeleton className="h-4 w-48 mb-3" />
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-5 w-5 rounded-md" />
                    <Skeleton className="h-5 w-5 rounded-md" />
                    <Skeleton className="h-5 w-5 rounded-md" />
                  </div>
                </motion.div>
              ))}
            </motion.div>
          ) : (
            <motion.div
              key="content"
              variants={containerVariants}
              initial="hidden"
              animate="show"
              className="space-y-1"
            >
              {windows.map((window) => (
                <TimelineBlock
                  key={window.id}
                  window={window}
                  isSelected={Number(selectedWindowId) === Number(window.id)}
                  hasLongEvent={windowsWithLongEvents.has(window.id)}
                  onClick={() => onSelectWindow(window.id)}
                  variants={itemVariants}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </ScrollArea>

      {/* Footer stats */}
      <motion.div className="px-4 py-2 text-xs text-muted-foreground" variants={variants}>
        <div className="flex items-center justify-between">
          <span>{t("activityMonitor.timeline.windows", { count: windows.length })}</span>
          <span>{t("activityMonitor.timeline.longEvents", { count: events.length })}</span>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{rangeText}</span>
          <div className="flex items-center gap-2">
            {loadedRangeMs && loadedRangeMs < 6 * 60 * 60 * 1000 && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!!isLoadingMore}
                onClick={() => onLoadMore?.("6h")}
              >
                {isLoadingMore ? <Loader2 className="animate-spin mr-2 h-3 w-3" /> : null}
                {t("activityMonitor.timeline.loadTo6h")}
              </Button>
            )}
            {loadedRangeMs &&
              loadedRangeMs >= 6 * 60 * 60 * 1000 &&
              loadedRangeMs < 24 * 60 * 60 * 1000 && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!!isLoadingMore}
                  onClick={() => onLoadMore?.("24h")}
                >
                  {isLoadingMore ? <Loader2 className="animate-spin mr-2 h-3 w-3" /> : null}
                  {t("activityMonitor.timeline.loadTo24h")}
                </Button>
              )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
