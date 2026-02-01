import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  Camera,
  ChevronDown,
  Loader2,
  PauseCircle,
  RotateCcw,
  Square,
  Settings,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SearchBar, Timeline, SummaryPanel } from "@/components/core/activity-monitor";
import { ActiveThreadLens } from "@/components/core/thread-lens/ActiveThreadLens";
import { useViewTransition } from "@/components/core/view-transition";
import { useActivityMonitor } from "@/hooks/use-activity-monitor";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { SearchResult } from "@shared/context-types";
import type { WindowSummary } from "@shared/activity-types";
import type { PermissionCheckResult, SchedulerStatePayload } from "@shared/ipc-types";
import { useInitServices } from "@/hooks/use-capture-source";
import { cn } from "@/lib/utils";

function DashboardSkeleton() {
  return (
    <div className="flex-1 flex gap-4 overflow-hidden px-2 pb-2 mt-2">
      {/* Timeline Skeleton */}
      <div className="w-80 shrink-0 flex flex-col gap-4">
        <div className="h-10 w-32 bg-muted/20 animate-pulse rounded-lg" />
        <div className="flex-1 space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 w-full bg-muted/10 animate-pulse rounded-2xl" />
          ))}
        </div>
      </div>
      {/* Summary Skeleton */}
      <div className="flex-1 flex flex-col gap-6">
        <div className="h-[40vh] w-full bg-muted/5 animate-pulse rounded-3xl" />
        <div className="space-y-4">
          <div className="h-8 w-1/3 bg-muted/20 animate-pulse rounded-lg" />
          <div className="h-4 w-full bg-muted/10 animate-pulse rounded-md" />
          <div className="h-4 w-5/6 bg-muted/10 animate-pulse rounded-md" />
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();
  const { initServices } = useInitServices();

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.03,
        duration: 0.2,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, scale: 0.98 },
    show: { opacity: 1, scale: 1 },
  };

  const { timeline, longEvents, getSummary, isLoadingTimeline } = useActivityMonitor();

  const [selectedWindowId, setSelectedWindowId] = useState<number | string | null>(null);
  const [selectedSummary, setSelectedSummary] = useState<WindowSummary | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [regeneratingWindowId, setRegeneratingWindowId] = useState<number | string | null>(null);
  const [isThreadLensOpen, setIsThreadLensOpen] = useState(true);

  const [permissionStatus, setPermissionStatus] = useState<PermissionCheckResult | null>(null);
  const [captureState, setCaptureState] = useState<SchedulerStatePayload | null>(null);
  const [isPreparingCapture, setIsPreparingCapture] = useState(false);

  const selectedWindow =
    selectedWindowId === null
      ? null
      : (timeline.find((w) => Number(w.id) === Number(selectedWindowId)) ?? null);

  const isRegeneratingSelectedWindow =
    selectedWindow != null && regeneratingWindowId != null
      ? Number(regeneratingWindowId) === Number(selectedWindow.id)
      : false;

  const handleRegenerateSummary = useCallback(async () => {
    if (!selectedWindow) return;
    if (selectedWindow.status !== "failed_permanent") return;

    const windowId = selectedWindow.id;
    const toastId = `activity-regenerate-${selectedWindow.windowStart}-${selectedWindow.windowEnd}`;

    setRegeneratingWindowId(windowId);
    toast(t("activityMonitor.summary.regeneratingToast"), { id: toastId });

    try {
      const res = await window.activityMonitorApi.regenerateSummary({
        windowStart: selectedWindow.windowStart,
        windowEnd: selectedWindow.windowEnd,
      });

      if (!res.success) {
        toast.error(res.error?.message ?? t("activityMonitor.summary.regenerateFailedToast"), {
          id: toastId,
        });
        return;
      }

      if (res.data?.ok) {
        toast.success(t("activityMonitor.summary.regenerateSuccessToast"), { id: toastId });
        return;
      }

      if (res.data?.reason === "not_initialized") {
        toast.error(t("activityMonitor.summary.regenerateNotInitializedToast"), { id: toastId });
        return;
      }

      toast.error(t("activityMonitor.summary.regenerateFailedToast"), { id: toastId });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("activityMonitor.summary.regenerateFailedToast"),
        {
          id: toastId,
        }
      );
    } finally {
      setRegeneratingWindowId((prev) => (Number(prev) === Number(windowId) ? null : prev));
    }
  }, [selectedWindow, t]);

  const hasActivityData =
    timeline.some((w) => {
      const nodeCount = w.stats?.nodeCount ?? 0;
      const screenshotCount = w.stats?.screenshotCount ?? 0;
      const title = w.title?.trim();
      return nodeCount > 0 || screenshotCount > 0 || !!title;
    }) || longEvents.length > 0;

  const showTimelineEmptyState = !isLoadingTimeline && !hasActivityData;
  const allPermissionsGranted =
    permissionStatus?.screenRecording === "granted" &&
    permissionStatus?.accessibility === "granted";
  const captureStatus = captureState?.status ?? null;
  const isCapturePausedOrStopped = captureStatus === "paused" || captureStatus === "stopped";

  // Default select the first window when timeline loads
  useEffect(() => {
    if (showTimelineEmptyState) return;

    if (timeline.length > 0 && selectedWindowId === null) {
      setSelectedWindowId(timeline[0].id);
    }
  }, [timeline, selectedWindowId, showTimelineEmptyState]);

  useEffect(() => {
    const load = async () => {
      try {
        const [perm, sched] = await Promise.all([
          window.permissionApi.check(),
          window.screenCaptureApi.getState(),
        ]);
        if (perm.success && perm.data) setPermissionStatus(perm.data);
        if (sched.success && sched.data) setCaptureState(sched.data);
      } catch {
        console.error("Failed to load permission/capture status");
      }
    };
    void load();
  }, []);

  // Initialize services (start capture) after timeline loads
  useEffect(() => {
    if (!isLoadingTimeline) {
      initServices();
    }
  }, [isLoadingTimeline, initServices]);

  useEffect(() => {
    const unsubscribe = window.screenCaptureApi.onStateChanged((payload) => {
      setCaptureState(payload);
    });
    const unsubscribePerm = window.permissionApi.onStatusChanged((payload) => {
      setPermissionStatus(payload);
    });
    return () => {
      unsubscribe();
      unsubscribePerm();
    };
  }, []);

  // Fetch summary when selected window changes
  useEffect(() => {
    if (showTimelineEmptyState) return;
    if (selectedWindowId === null) return;

    const window = timeline.find((w) => w.id === selectedWindowId);
    if (!window) return;

    if (window.status !== "succeeded") {
      setSelectedSummary(null);
      setIsLoadingSummary(false);
      return;
    }

    let cancelled = false;

    const fetchSummary = async () => {
      setIsLoadingSummary(true);
      setSelectedSummary(null);
      try {
        const summary = await getSummary(window.windowStart, window.windowEnd);
        if (!cancelled) {
          setSelectedSummary(summary);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSummary(false);
        }
      }
    };

    void fetchSummary();

    return () => {
      cancelled = true;
    };
  }, [selectedWindowId, timeline, getSummary, showTimelineEmptyState]);

  const handleSearchStart = useCallback((query: string) => {
    console.log("Search started:", query);
  }, []);

  const handleSearchComplete = useCallback(
    (result: SearchResult, query: string) => {
      console.log("Search complete:", result);
      // Navigate to search results page with the result data
      navigate("/search-results", {
        state: {
          query,
          result,
        },
      });
    },
    [navigate]
  );

  const handleSearchCancel = useCallback(() => {
    console.log("Search cancelled");
  }, []);

  const handleOpenSettings = useCallback(() => {
    navigate("/settings", { type: "fade", duration: 250 });
  }, [navigate]);

  const handlePrepareCapture = useCallback(async () => {
    setIsPreparingCapture(true);
    try {
      const perm = await window.permissionApi.check();
      if (perm.success && perm.data) {
        setPermissionStatus(perm.data);
        if (perm.data.screenRecording !== "granted") {
          await window.permissionApi.openScreenRecordingSettings();
          return;
        }
        if (perm.data.accessibility !== "granted") {
          await window.permissionApi.openAccessibilitySettings();
          return;
        }
      }

      const before = await window.screenCaptureApi.getState();
      const status = before.success && before.data ? before.data.status : null;
      if (status === "paused") {
        await window.screenCaptureApi.resume();
      } else if (status !== "running") {
        await window.screenCaptureApi.start();
      }
      const sched = await window.screenCaptureApi.getState();
      if (sched.success && sched.data) setCaptureState(sched.data);
    } finally {
      setIsPreparingCapture(false);
    }
  }, []);

  const handleStopCapture = useCallback(async () => {
    setIsPreparingCapture(true);
    try {
      await window.screenCaptureApi.stop();
      const sched = await window.screenCaptureApi.getState();
      if (sched.success && sched.data) setCaptureState(sched.data);
    } finally {
      setIsPreparingCapture(false);
    }
  }, []);

  const handleRequestPermissions = useCallback(async () => {
    setIsPreparingCapture(true);
    try {
      const perm = await window.permissionApi.check();
      if (perm.success && perm.data) {
        if (perm.data.screenRecording !== "granted") {
          await window.permissionApi.requestScreenRecording();
        }
        if (perm.data.accessibility !== "granted") {
          await window.permissionApi.requestAccessibility();
        }
      }
      const after = await window.permissionApi.check();
      if (after.success && after.data) setPermissionStatus(after.data);
    } finally {
      setIsPreparingCapture(false);
    }
  }, []);

  useEffect(() => {
    if (!showTimelineEmptyState) return;
    setSelectedWindowId(null);
    setSelectedSummary(null);
  }, [showTimelineEmptyState]);

  return (
    <motion.div
      className="min-h-[calc(100vh-88px)] flex flex-col -mt-2"
      variants={containerVariants}
      initial={false}
      animate="show"
    >
      {/* Search Bar Container with layout animation */}
      <motion.div
        layout
        className={cn(
          "px-2 flex flex-col",
          showTimelineEmptyState ? "pt-4 pb-4 items-center w-full" : "mt-0 mb-5"
        )}
        transition={{
          layout: { type: "spring", stiffness: 200, damping: 25, mass: 0.5 },
        }}
      >
        <SearchBar
          onSearchStart={handleSearchStart}
          onSearchComplete={handleSearchComplete}
          onSearchCancel={handleSearchCancel}
          variants={itemVariants}
        />
      </motion.div>

      {!showTimelineEmptyState ? (
        <div className="px-2 mb-3">
          <Collapsible open={isThreadLensOpen} onOpenChange={setIsThreadLensOpen}>
            <div className="rounded-xl bg-card/40">
              <div className="flex items-center gap-3 px-3 py-2">
                <div className="text-base font-semibold text-muted-foreground flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  <div className="text-base font-bold text-foreground tracking-tight">
                    {t("threadLens.title")}
                  </div>
                </div>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 px-2">
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 transition-transform",
                        isThreadLensOpen ? "rotate-180" : ""
                      )}
                    />
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <div className="px-3 pb-3">
                  <ActiveThreadLens />
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>
      ) : null}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-h-0">
        <AnimatePresence mode="wait" initial={false}>
          {isLoadingTimeline && !hasActivityData ? (
            <motion.div
              key="loading-skeleton"
              className="flex-1 flex flex-col"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <DashboardSkeleton />
            </motion.div>
          ) : (
            (hasActivityData || !isLoadingTimeline) && (
              <motion.div
                key="dashboard-content"
                className="flex-1 flex flex-col min-h-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                {showTimelineEmptyState ? (
                  <div className="flex-1 flex items-start justify-center px-4">
                    <Empty className="w-full max-w-full border border-dashed bg-card/40 mt-2 h-full">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Sparkles />
                        </EmptyMedia>
                        <EmptyTitle>{t("activityMonitor.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("activityMonitor.empty.description")}
                        </EmptyDescription>
                      </EmptyHeader>
                      <EmptyContent>
                        <div className="w-full space-y-2">
                          <div className="rounded-lg border bg-background p-3 text-left">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <ShieldCheck className="h-4 w-4" />
                              {t("activityMonitor.empty.permissionsTitle")}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                              {permissionStatus ? (
                                <div className="space-y-1">
                                  <div>
                                    {t("activityMonitor.empty.screenRecording")}：
                                    {permissionStatus.screenRecording === "granted"
                                      ? t("activityMonitor.empty.granted")
                                      : t("activityMonitor.empty.notGranted")}
                                  </div>
                                  <div>
                                    {t("activityMonitor.empty.accessibility")}：
                                    {permissionStatus.accessibility === "granted"
                                      ? t("activityMonitor.empty.granted")
                                      : t("activityMonitor.empty.notGranted")}
                                  </div>
                                </div>
                              ) : (
                                t("activityMonitor.empty.unknown")
                              )}
                            </div>
                          </div>

                          <div className="rounded-lg border bg-background p-3 text-left">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <Camera className="h-4 w-4" />
                              {t("activityMonitor.empty.captureTitle")}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                              {captureState
                                ? t("activityMonitor.empty.captureCurrent", {
                                    status: captureState.status,
                                  })
                                : t("activityMonitor.empty.unknown")}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col gap-2 w-full">
                          {!allPermissionsGranted ? (
                            <Button
                              onClick={handleRequestPermissions}
                              disabled={isPreparingCapture}
                            >
                              {isPreparingCapture
                                ? t("activityMonitor.empty.working")
                                : t("activityMonitor.empty.grantPermissions")}
                            </Button>
                          ) : (
                            <Button
                              onClick={handlePrepareCapture}
                              disabled={isPreparingCapture || captureStatus === "running"}
                            >
                              {captureStatus === "running"
                                ? t("activityMonitor.empty.capturing")
                                : isPreparingCapture
                                  ? t("activityMonitor.empty.starting")
                                  : captureStatus === "paused"
                                    ? t("activityMonitor.empty.resume")
                                    : t("activityMonitor.empty.start")}
                            </Button>
                          )}
                          {(captureStatus === "running" || captureStatus === "paused") && (
                            <Button
                              variant="destructive"
                              onClick={handleStopCapture}
                              disabled={isPreparingCapture}
                            >
                              <Square className="h-4 w-4 mr-2" />
                              {t("activityMonitor.empty.stop", "Stop capture")}
                            </Button>
                          )}
                          <Button variant="outline" onClick={handleOpenSettings}>
                            <Settings className="h-4 w-4 mr-2" />
                            {t("activityMonitor.empty.openSettings")}
                          </Button>
                        </div>
                      </EmptyContent>
                    </Empty>
                  </div>
                ) : (
                  <div className="flex-1 flex gap-4 overflow-hidden px-2 pb-2 min-h-0">
                    {/* Left Panel - Timeline */}
                    <motion.div className="w-80 shrink-0 flex flex-col" variants={itemVariants}>
                      <Timeline
                        windows={timeline}
                        events={longEvents}
                        selectedWindowId={selectedWindowId}
                        onSelectWindow={setSelectedWindowId}
                        isLoading={isLoadingTimeline}
                        variants={itemVariants}
                      />
                    </motion.div>

                    {/* Right Panel - Summary */}
                    <motion.div className="flex-1 min-w-0 flex flex-col" variants={itemVariants}>
                      {isCapturePausedOrStopped ? (
                        <div className="mb-2">
                          <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-50 w-full max-w-full">
                            <PauseCircle className="h-4 w-4" />
                            <AlertTitle>
                              {t("activityMonitor.banner.capturePausedTitle")}
                            </AlertTitle>
                            <AlertDescription>
                              {t("activityMonitor.banner.capturePausedDescription")}
                            </AlertDescription>
                          </Alert>
                        </div>
                      ) : null}
                      {selectedWindow && selectedWindow.status !== "succeeded" ? (
                        <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-card/50 rounded-xl border border-border/50">
                          {selectedWindow.status === "pending" ||
                          (selectedWindow.status === "failed_permanent" &&
                            isRegeneratingSelectedWindow) ? (
                            <>
                              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4" />
                              <h3 className="text-lg font-medium text-muted-foreground mb-2">
                                {t("activityMonitor.summary.processingTitle")}
                              </h3>
                              <p className="text-sm text-muted-foreground/70">
                                {t("activityMonitor.summary.processingDescription")}
                              </p>
                            </>
                          ) : selectedWindow.status === "failed_permanent" ? (
                            <>
                              <AlertTriangle className="h-16 w-16 text-muted-foreground/30 mb-4" />
                              <h3 className="text-lg font-medium text-muted-foreground mb-2">
                                {t("activityMonitor.summary.failedPermanentTitle")}
                              </h3>
                              <p className="text-sm text-muted-foreground/70">
                                {t("activityMonitor.summary.failedPermanentDescription")}
                              </p>
                              <div className="mt-5">
                                <Button
                                  onClick={handleRegenerateSummary}
                                  disabled={isRegeneratingSelectedWindow}
                                >
                                  {isRegeneratingSelectedWindow ? (
                                    <>
                                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                      {t("activityMonitor.summary.regeneratingButton")}
                                    </>
                                  ) : (
                                    <>
                                      <RotateCcw className="mr-2 h-4 w-4" />
                                      {t("activityMonitor.summary.regenerateButton")}
                                    </>
                                  )}
                                </Button>
                              </div>
                            </>
                          ) : (
                            <>
                              <AlertTriangle className="h-16 w-16 text-muted-foreground/30 mb-4" />
                              <h3 className="text-lg font-medium text-muted-foreground mb-2">
                                {t("activityMonitor.summary.failedTitle")}
                              </h3>
                              <p className="text-sm text-muted-foreground/70">
                                {t("activityMonitor.summary.failedDescription")}
                              </p>
                            </>
                          )}
                        </div>
                      ) : (
                        <SummaryPanel
                          summary={selectedSummary}
                          isLoading={isLoadingSummary}
                          variants={itemVariants}
                        />
                      )}
                    </motion.div>
                  </div>
                )}
              </motion.div>
            )
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
