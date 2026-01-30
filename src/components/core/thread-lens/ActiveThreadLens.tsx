import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { Sparkles, Pin, PinOff, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { Thread } from "@shared/context-types";
import type { ThreadBrief } from "@shared/thread-lens-types";
import { MarkdownContent } from "@/components/core/activity-monitor/MarkdownContent";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

type LoadState = {
  pinnedThreadId: string | null;
  candidates: Thread[];
  resolved: Thread | null;
};

type BriefStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

const BRIEF_REFRESH_COOLDOWN_MS = 30_000;
const BRIEF_REFRESH_ACTIVE_AT_DELTA_MS = 5 * 60 * 1000;

export function ActiveThreadLens() {
  const { t: tr } = useTranslation();
  const lastLoadAtRef = useRef(0);
  const isLoadingRef = useRef(false);
  const timelineRefreshTimeoutRef = useRef<number | null>(null);
  const lastBriefFetchRef = useRef<{
    threadId: string;
    lastActiveAt: number | null;
    fetchedAt: number;
  } | null>(null);

  const [loadState, setLoadState] = useState<LoadState>({
    pinnedThreadId: null,
    candidates: [],
    resolved: null,
  });
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const [brief, setBrief] = useState<ThreadBrief | null>(null);
  const [briefStatus, setBriefStatus] = useState<BriefStatus>("idle");
  const [briefError, setBriefError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingBrief, setIsRefreshingBrief] = useState(false);

  const load = useCallback(async (opts?: { markLoading?: boolean; ignoreCooldown?: boolean }) => {
    const markLoading = opts?.markLoading ?? true;
    const ignoreCooldown = opts?.ignoreCooldown ?? false;
    const now = Date.now();
    if (isLoadingRef.current) return;
    if (!ignoreCooldown && now - lastLoadAtRef.current < 1500) return;
    lastLoadAtRef.current = now;
    isLoadingRef.current = true;
    if (markLoading) setIsLoading(true);

    try {
      const [stateRes, candidatesRes, resolvedRes] = await Promise.all([
        window.threadsApi.getActiveState(),
        window.threadsApi.getActiveCandidates(),
        window.threadsApi.getResolvedActive(),
      ]);

      setLoadState({
        pinnedThreadId: stateRes.success ? (stateRes.data?.state.pinnedThreadId ?? null) : null,
        candidates: candidatesRes.success ? (candidatesRes.data?.threads ?? []) : [],
        resolved: resolvedRes.success ? (resolvedRes.data?.thread ?? null) : null,
      });
    } finally {
      if (markLoading) setIsLoading(false);
      isLoadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = window.activityMonitorApi.onTimelineChanged(() => {
      if (timelineRefreshTimeoutRef.current != null) {
        window.clearTimeout(timelineRefreshTimeoutRef.current);
        timelineRefreshTimeoutRef.current = null;
      }
      timelineRefreshTimeoutRef.current = window.setTimeout(() => {
        timelineRefreshTimeoutRef.current = null;
        void load({ markLoading: false, ignoreCooldown: true });
      }, 800);
    });
    return () => {
      if (timelineRefreshTimeoutRef.current != null) {
        window.clearTimeout(timelineRefreshTimeoutRef.current);
      }
      unsubscribe();
    };
  }, [load]);

  const viewModel = useMemo(() => {
    const pool = [...loadState.candidates];
    if (loadState.resolved && !pool.some((t) => t.id === loadState.resolved?.id)) {
      pool.push(loadState.resolved);
    }
    if (pool.length === 0) return null;

    let active = pool.find((t) => t.id === focusThreadId);
    if (!active) active = loadState.resolved || pool[0];

    const others = pool
      .filter((t) => t.id !== active.id)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    return { active, others, isPinned: loadState.pinnedThreadId === active.id };
  }, [loadState.candidates, loadState.resolved, focusThreadId, loadState.pinnedThreadId]);

  const active = viewModel?.active;
  const others = viewModel?.others ?? [];
  const isPinnedActive = viewModel?.isPinned ?? false;
  const activeThreadId = active?.id ?? null;
  const activeThreadLastActiveAt = active?.lastActiveAt ?? null;

  useEffect(() => {
    let ignore = false;
    const run = async () => {
      if (!activeThreadId) {
        setBrief(null);
        setBriefStatus("idle");
        setBriefError(null);
        return;
      }

      const now = Date.now();
      const last = lastBriefFetchRef.current;
      const isSameThread = last?.threadId === activeThreadId;
      const activeAtDeltaOk =
        isSameThread &&
        last?.lastActiveAt != null &&
        activeThreadLastActiveAt != null &&
        activeThreadLastActiveAt - last.lastActiveAt < BRIEF_REFRESH_ACTIVE_AT_DELTA_MS;
      const withinCooldown =
        isSameThread && now - (last?.fetchedAt ?? 0) < BRIEF_REFRESH_COOLDOWN_MS;

      if (isSameThread && withinCooldown && activeAtDeltaOk) return;

      lastBriefFetchRef.current = {
        threadId: activeThreadId,
        lastActiveAt: activeThreadLastActiveAt,
        fetchedAt: now,
      };

      if (!isSameThread || !brief?.briefMarkdown) {
        setBriefStatus("loading");
        setBriefError(null);
      }

      const res = await window.threadsApi.getBrief({ threadId: activeThreadId, force: false });
      if (ignore) return;

      if (!res.success) {
        setBrief(null);
        setBriefStatus("error");
        setBriefError(res.error?.message ?? null);
        return;
      }

      const next = res.data?.brief ?? null;
      setBrief(next);
      setBriefStatus(next?.briefMarkdown ? "ready" : "unavailable");
    };

    void run();
    return () => {
      ignore = true;
    };
  }, [activeThreadId, activeThreadLastActiveAt, brief?.briefMarkdown]);

  const isPreviewing = focusThreadId != null;

  const handleReturnToAuto = useCallback(() => setFocusThreadId(null), []);

  const handlePinToggle = useCallback(async () => {
    if (!active) return;
    if (loadState.pinnedThreadId === active.id) {
      await window.threadsApi.unpin();
    } else {
      await window.threadsApi.pin({ threadId: active.id });
    }
    await load();
  }, [active, load, loadState.pinnedThreadId]);

  const handleRefresh = useCallback(async () => {
    if (!active) {
      await load();
      return;
    }
    setIsRefreshingBrief(true);
    setBriefStatus("loading");
    setBriefError(null);
    try {
      const res = await window.threadsApi.getBrief({ threadId: active.id, force: true });
      if (!res.success) {
        setBrief(null);
        setBriefStatus("error");
        setBriefError(res.error?.message ?? null);
      } else {
        const next = res.data?.brief ?? null;
        setBrief(next);
        setBriefStatus(next?.briefMarkdown ? "ready" : "unavailable");
      }
      await load();
    } finally {
      setIsRefreshingBrief(false);
    }
  }, [active, load]);

  if (!viewModel || !active) return null;

  return (
    <div className="w-full relative flex flex-col gap-3">
      {/* 1. Header Badges Area */}
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40">
          <AnimatePresence mode="wait">
            {isPreviewing ? (
              <motion.span
                key="preview"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-sky-500/80 flex items-center gap-1.5"
              >
                <Sparkles className="h-3 w-3" /> {tr("threadLens.state.temporaryFocus")}
              </motion.span>
            ) : loadState.pinnedThreadId ? (
              <motion.span
                key="pinned"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-amber-500/80 flex items-center gap-1.5"
              >
                <Pin className="h-3 w-3 fill-current" /> {tr("threadLens.state.pinned")}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>

        {isPreviewing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[9px] font-black uppercase tracking-widest hover:bg-sky-500/10 text-sky-500/70 hover:text-sky-500 transition-all rounded-full"
            onClick={handleReturnToAuto}
          >
            <X className="h-2.5 w-2.5 mr-1" />
            {tr("threadLens.actions.clearTemporaryFocus")}
          </Button>
        )}
      </div>

      <LayoutGroup>
        {/* 2. Candidate Tabs */}
        {others.length > 0 && (
          <div className="flex flex-col gap-1 px-2 relative z-10">
            {others.map((t) => (
              <motion.div
                key={t.id}
                layoutId={`thread-container-${t.id}`}
                className="group relative"
                onClick={() => setFocusThreadId(t.id)}
              >
                <div className="h-8 flex items-center px-4 bg-muted/10 hover:bg-muted/30 backdrop-blur-md border border-border/20 border-dashed rounded-lg cursor-pointer transition-all overflow-hidden">
                  <motion.span
                    layout="position"
                    className="text-xs font-medium text-muted-foreground/60 truncate flex-1 group-hover:text-foreground/80"
                  >
                    {t.title || tr("threadLens.untitled")}
                  </motion.span>
                  <motion.span
                    layout="position"
                    className="text-[9px] font-bold text-muted-foreground/20 tabular-nums ml-4"
                  >
                    {format(new Date(t.lastActiveAt), "HH:mm")}
                  </motion.span>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* 3. Main Active Card */}
        <motion.div
          key={active.id}
          layoutId={`thread-container-${active.id}`}
          className="relative z-20"
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
        >
          <Card
            className={cn(
              "overflow-hidden bg-card/60 backdrop-blur-xl border-border/60 shadow-2xl",
              isPinnedActive && "border-amber-500/30",
              isPreviewing && "border-sky-500/30"
            )}
          >
            <CardHeader className="py-5 px-6 pb-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <motion.div layout="position" className="flex items-center gap-2.5">
                    <CardTitle className="text-xl font-black tracking-tight leading-tight">
                      {active.title || tr("threadLens.untitled")}
                    </CardTitle>
                    {isPinnedActive && (
                      <Pin className="h-4 w-4 text-amber-500 fill-amber-500 shadow-sm shrink-0" />
                    )}
                  </motion.div>
                  <motion.div layout="position" className="mt-3 flex items-center gap-2">
                    {active.currentPhase && (
                      <TooltipProvider delayDuration={400}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className="text-xs font-bold border-muted-foreground/20 text-muted-foreground py-0.5 px-2 cursor-help"
                            >
                              <motion.span layout="position">{active.currentPhase}</motion.span>
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent
                            side="bottom"
                            className="text-xs font-bold tracking-wider"
                          >
                            {tr("threadLens.tooltips.currentPhase", { phase: active.currentPhase })}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <motion.span
                      layout="position"
                      className="text-[10px] text-muted-foreground/20 font-bold ml-auto tabular-nums"
                    >
                      {format(new Date(active.lastActiveAt), "HH:mm:ss")}
                    </motion.span>
                  </motion.div>
                </div>

                <div className="shrink-0 flex items-center gap-2 pt-1">
                  <TooltipProvider delayDuration={400}>
                    <div className="flex items-center gap-1.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full border border-border/20 hover:bg-primary/5 group"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRefresh();
                            }}
                            disabled={isLoading || isRefreshingBrief}
                          >
                            <RefreshCw
                              className={cn(
                                "h-4 w-4 text-muted-foreground/60 transition-colors group-hover:text-primary",
                                (isLoading || isRefreshingBrief) && "animate-spin"
                              )}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          className="text-[10px] font-bold uppercase tracking-wider"
                        >
                          {tr("threadLens.actions.refresh")}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "h-8 w-8 rounded-full border border-border/20 transition-all",
                              isPinnedActive
                                ? "text-amber-500 bg-amber-500/10 border-amber-500/20"
                                : "text-muted-foreground/60 hover:text-amber-500 hover:bg-amber-500/5"
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handlePinToggle();
                            }}
                            disabled={isLoading}
                          >
                            {isPinnedActive ? (
                              <PinOff className="h-4 w-4" />
                            ) : (
                              <Pin className="h-4 w-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          className="text-[10px] font-bold uppercase tracking-wider"
                        >
                          {isPinnedActive
                            ? tr("threadLens.actions.unpin")
                            : tr("threadLens.tooltips.pin")}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TooltipProvider>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-6 py-4 pt-0 pb-6">
              <motion.div
                layout="position"
                className="text-base text-muted-foreground/80 leading-relaxed font-medium mb-6 pl-5 border-l-2 border-primary/20"
              >
                {active.summary}
              </motion.div>

              <AnimatePresence mode="wait">
                {briefStatus === "ready" && brief?.briefMarkdown ? (
                  <motion.div
                    key="brief"
                    layout="position"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="relative rounded-2xl border border-primary/10 bg-gradient-to-br from-primary/[0.03] to-transparent p-6 pt-10"
                  >
                    <div className="absolute top-4 left-6 flex items-center gap-2 opacity-40">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary">
                        {tr("threadLens.brief.title")}
                      </span>
                    </div>

                    {brief?.highlights?.length ? (
                      <div className="mb-4 flex flex-wrap gap-2">
                        {brief.highlights.slice(0, 4).map((h, i) => (
                          <Badge
                            key={i}
                            variant="secondary"
                            className="text-xs font-bold bg-white/5 border-none opacity-70"
                          >
                            {h}
                          </Badge>
                        ))}
                      </div>
                    ) : null}

                    <div className="max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                      <MarkdownContent content={brief.briefMarkdown} variant="compact" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card/30 to-transparent pointer-events-none" />
                  </motion.div>
                ) : briefStatus === "loading" ? (
                  <div className="h-24 flex flex-col items-center justify-center border border-dashed border-primary/20 rounded-2xl bg-primary/[0.01]">
                    <RefreshCw className="h-5 w-5 text-primary/20 animate-spin mb-2" />
                    <span className="text-[9px] font-black uppercase tracking-[0.2em] text-primary/30 animate-pulse">
                      Synthesizing
                    </span>
                  </div>
                ) : (
                  <div className="h-20 flex flex-col items-center justify-center border border-dashed border-border/30 rounded-2xl bg-muted/5 px-4 overflow-hidden">
                    <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40 text-center line-clamp-2">
                      {briefStatus === "error"
                        ? briefError || "Engine Error"
                        : tr("threadLens.brief.unavailableBody")}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1.5 h-6 text-[9px] font-bold uppercase tracking-widest text-primary/60 hover:text-primary transition-colors"
                      onClick={handleRefresh}
                    >
                      {tr("threadLens.brief.retry")}
                    </Button>
                  </div>
                )}
              </AnimatePresence>
            </CardContent>
          </Card>
        </motion.div>
      </LayoutGroup>
    </div>
  );
}
