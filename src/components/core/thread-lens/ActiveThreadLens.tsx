import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { Sparkles, Pin, PinOff, RefreshCw, X, MoreHorizontal, PauseCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ThreadBrief, ThreadLensStateSnapshot } from "@shared/thread-lens-types";
import { MarkdownContent } from "@/components/core/activity-monitor/MarkdownContent";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

type BriefStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

type BriefCacheEntry = {
  brief: ThreadBrief | null;
  lastActiveAt: number | null;
};

export function ActiveThreadLens() {
  const { t: tr } = useTranslation();

  const briefCacheRef = useRef<Map<string, BriefCacheEntry>>(new Map());
  const briefRefreshHintRef = useRef<Map<string, number>>(new Map());
  const briefRequestIdRef = useRef(0);
  const activeBriefRequestRef = useRef<{ requestId: number; threadId: string | null }>({
    requestId: 0,
    threadId: null,
  });

  const [lensState, setLensState] = useState<ThreadLensStateSnapshot | null>(null);
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const [brief, setBrief] = useState<ThreadBrief | null>(null);
  const [briefStatus, setBriefStatus] = useState<BriefStatus>("idle");
  const [briefError, setBriefError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingBrief, setIsRefreshingBrief] = useState(false);
  const [isMarkInactiveDialogOpen, setIsMarkInactiveDialogOpen] = useState(false);
  const [markInactiveThread, setMarkInactiveThread] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [isMarkingInactive, setIsMarkingInactive] = useState(false);

  const reloadLensState = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await window.threadsApi.getLensState();
      if (!res.success) {
        setLensState(null);
        return;
      }

      setLensState(res.data?.snapshot ?? null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadLensState();
  }, [reloadLensState]);

  useEffect(() => {
    return window.threadsApi.onLensStateChanged((payload) => {
      setLensState((prev) => {
        if (!prev) return payload.snapshot;
        if (payload.snapshot.revision <= prev.revision) return prev;
        return payload.snapshot;
      });
    });
  }, []);

  const viewModel = useMemo(() => {
    const snapshot = lensState;
    if (!snapshot) return null;

    const pool = [...snapshot.topThreads];
    if (pool.length === 0) return null;

    const resolved = snapshot.resolvedThreadId
      ? (pool.find((t) => t.id === snapshot.resolvedThreadId) ?? null)
      : null;

    const activeCandidateId = focusThreadId ?? resolved?.id ?? pool[0]?.id ?? null;
    const active = pool.find((t) => t.id === activeCandidateId) ?? pool[0];

    const others = pool
      .filter((t) => t.id !== active.id)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    return { active, others, isPinned: snapshot.pinnedThreadId === active.id };
  }, [focusThreadId, lensState]);

  const active = viewModel?.active;
  const others = viewModel?.others ?? [];
  const isPinnedActive = viewModel?.isPinned ?? false;
  const activeThreadId = active?.id ?? null;

  const fetchBrief = useCallback(
    async (
      threadId: string,
      expectedLastActiveAt: number | null,
      opts?: { force?: boolean; showLoading?: boolean; ignoreCache?: boolean }
    ) => {
      const refreshHintAtStart = briefRefreshHintRef.current.get(threadId) ?? null;
      const force = opts?.force ?? false;
      const showLoading = opts?.showLoading ?? true;
      const ignoreCache = opts?.ignoreCache ?? false;

      if (!force && !ignoreCache) {
        const cached = briefCacheRef.current.get(threadId);
        if (cached) {
          const cancelRequestId = (briefRequestIdRef.current += 1);
          activeBriefRequestRef.current = { requestId: cancelRequestId, threadId };
          setBrief(cached.brief);
          setBriefStatus(cached.brief?.briefMarkdown ? "ready" : "unavailable");
          setBriefError(null);
          return;
        }
      }

      const requestId = (briefRequestIdRef.current += 1);
      activeBriefRequestRef.current = { requestId, threadId };

      if (showLoading) {
        setBriefStatus("loading");
        setBriefError(null);
      }

      const res = await window.threadsApi.getBrief({ threadId, force });
      if (activeBriefRequestRef.current.requestId !== requestId) return;

      if (!res.success) {
        setBrief(null);
        setBriefStatus("error");
        setBriefError(res.error?.message ?? null);
        return;
      }

      const next = res.data?.brief ?? null;
      briefCacheRef.current.set(threadId, {
        brief: next,
        lastActiveAt: next?.lastActiveAt ?? expectedLastActiveAt,
      });

      if (
        refreshHintAtStart != null &&
        briefRefreshHintRef.current.get(threadId) === refreshHintAtStart
      ) {
        briefRefreshHintRef.current.delete(threadId);
      }

      setBrief(next);
      setBriefStatus(next?.briefMarkdown ? "ready" : "unavailable");
      setBriefError(null);
    },
    []
  );

  useEffect(() => {
    if (!activeThreadId) {
      const cancelRequestId = (briefRequestIdRef.current += 1);
      activeBriefRequestRef.current = { requestId: cancelRequestId, threadId: null };
      setBrief(null);
      setBriefStatus("idle");
      setBriefError(null);
      return;
    }

    const cancelRequestId = (briefRequestIdRef.current += 1);
    activeBriefRequestRef.current = { requestId: cancelRequestId, threadId: activeThreadId };

    const cached = briefCacheRef.current.get(activeThreadId);
    const refreshHint = briefRefreshHintRef.current.get(activeThreadId) ?? null;
    if (cached) {
      setBrief(cached.brief);
      setBriefStatus(cached.brief?.briefMarkdown ? "ready" : "unavailable");
      setBriefError(null);
    }

    if (cached && refreshHint == null) return;

    const shouldShowLoading = !cached?.brief?.briefMarkdown;

    void fetchBrief(activeThreadId, refreshHint, {
      force: false,
      showLoading: shouldShowLoading,
      ignoreCache: refreshHint != null,
    });
  }, [activeThreadId, fetchBrief]);

  useEffect(() => {
    return window.threadsApi.onThreadBriefUpdated((payload) => {
      briefRefreshHintRef.current.set(payload.threadId, payload.lastActiveAt);
      if (payload.threadId === activeThreadId) {
        void fetchBrief(payload.threadId, payload.lastActiveAt, {
          force: false,
          showLoading: false,
          ignoreCache: true,
        });
      }
    });
  }, [activeThreadId, fetchBrief]);

  useEffect(() => {
    if (!focusThreadId) return;
    const stillVisible = lensState?.topThreads.some((t) => t.id === focusThreadId) ?? false;
    if (!stillVisible) {
      setFocusThreadId(null);
    }
  }, [focusThreadId, lensState?.topThreads]);

  const isPreviewing = focusThreadId != null;

  const handleReturnToAuto = useCallback(() => setFocusThreadId(null), []);

  const handlePinToggle = useCallback(async () => {
    if (!active) return;
    if (lensState?.pinnedThreadId === active.id) {
      await window.threadsApi.unpin();
    } else {
      await window.threadsApi.pin({ threadId: active.id });
    }
  }, [active, lensState?.pinnedThreadId]);

  const handleRefresh = useCallback(async () => {
    if (!active) return;
    setIsRefreshingBrief(true);
    try {
      await fetchBrief(active.id, active.lastActiveAt, {
        force: true,
        showLoading: true,
        ignoreCache: true,
      });
    } finally {
      setIsRefreshingBrief(false);
    }
  }, [active, fetchBrief]);

  const openMarkInactiveDialog = useCallback(() => {
    if (!active) return;
    setMarkInactiveThread({ id: active.id, title: active.title || tr("threadLens.untitled") });
    setIsMarkInactiveDialogOpen(true);
  }, [active, tr]);

  const handleConfirmMarkInactive = useCallback(async () => {
    const target = markInactiveThread;
    if (!target) return;
    if (isMarkingInactive) return;

    const toastId = `thread-mark-inactive-${target.id}`;
    setIsMarkingInactive(true);
    toast(tr("threadLens.messages.markInactiveLoading"), { id: toastId });

    try {
      const res = await window.threadsApi.markInactive({ threadId: target.id });
      if (!res.success) {
        toast.error(res.error?.message ?? tr("threadLens.messages.markInactiveFailed"), {
          id: toastId,
        });
        return;
      }

      toast.success(tr("threadLens.messages.markInactiveSuccess"), { id: toastId });
      setIsMarkInactiveDialogOpen(false);
      setMarkInactiveThread(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tr("threadLens.messages.markInactiveFailed"),
        { id: toastId }
      );
    } finally {
      setIsMarkingInactive(false);
    }
  }, [isMarkingInactive, markInactiveThread, tr]);

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
            ) : lensState?.pinnedThreadId ? (
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
                <div className="h-8 flex items-center px-4 bg-muted/10 hover:bg-muted/30 backdrop-blur-md border border-border border-dashed rounded-lg cursor-pointer transition-all overflow-hidden">
                  <motion.span
                    layout="position"
                    className="text-xs font-medium text-muted-foreground/60 truncate flex-1 group-hover:text-foreground/80"
                  >
                    {t.title || tr("threadLens.untitled")}
                  </motion.span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] font-bold py-0 px-1.5 ml-2 shrink-0",
                      t.status === "active" &&
                        "border-emerald-500/30 text-emerald-500 bg-emerald-500/5",
                      t.status === "inactive" &&
                        "border-amber-500/30 text-amber-500 bg-amber-500/5",
                      t.status === "closed" &&
                        "border-muted-foreground/30 text-muted-foreground bg-muted/10"
                    )}
                  >
                    {tr(`threadLens.status.${t.status}`)}
                  </Badge>
                  <motion.span
                    layout="position"
                    className="text-xs font-bold text-muted-foreground tabular-nums ml-4"
                  >
                    {format(new Date(t.lastActiveAt), "MM/dd HH:mm")}
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
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-xs font-bold py-0.5 px-2",
                        active.status === "active" &&
                          "border-emerald-500/30 text-emerald-500 bg-emerald-500/5",
                        active.status === "inactive" &&
                          "border-amber-500/30 text-amber-500 bg-amber-500/5",
                        active.status === "closed" &&
                          "border-muted-foreground/30 text-muted-foreground bg-muted/10"
                      )}
                    >
                      {tr(`threadLens.status.${active.status}`)}
                    </Badge>
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
                      className="text-xs text-muted-foreground font-bold ml-auto tabular-nums"
                    >
                      {format(new Date(active.lastActiveAt), "MM/dd HH:mm:ss")}
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

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full border border-border/20 text-muted-foreground/60 hover:text-foreground hover:bg-muted/20"
                            onClick={(e) => e.stopPropagation()}
                            disabled={isLoading}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenuItem
                            onSelect={(e) => {
                              e.preventDefault();
                              openMarkInactiveDialog();
                            }}
                            disabled={active.status !== "active" || isMarkingInactive}
                            className="text-amber-500 focus:text-amber-500"
                          >
                            <PauseCircle className="h-4 w-4" />
                            {tr("threadLens.actions.markInactive")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={(e) => {
                              e.preventDefault();
                              void handleRefresh();
                            }}
                            disabled={isLoading || isRefreshingBrief}
                          >
                            <RefreshCw
                              className={cn(
                                "h-4 w-4",
                                (isLoading || isRefreshingBrief) && "animate-spin"
                              )}
                            />
                            {tr("threadLens.actions.refresh")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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

      <AlertDialog
        open={isMarkInactiveDialogOpen}
        onOpenChange={(open) => {
          if (isMarkingInactive) return;
          setIsMarkInactiveDialogOpen(open);
          if (!open) setMarkInactiveThread(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("threadLens.dialogs.markInactive.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr("threadLens.dialogs.markInactive.description", {
                title: markInactiveThread?.title ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMarkingInactive}>
              {tr("common.buttons.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmMarkInactive();
              }}
              disabled={!markInactiveThread || isMarkingInactive}
            >
              {isMarkingInactive
                ? tr("threadLens.dialogs.markInactive.confirming")
                : tr("threadLens.dialogs.markInactive.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
