import React, { useEffect, useState } from "react";
import { useTheme } from "@/providers/theme-provider";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Camera, Loader2, PauseCircle, PlayCircle } from "lucide-react";

export const TitleBar: React.FC = () => {
  const { effectiveTheme } = useTheme();
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<
    "idle" | "running" | "paused" | "stopped" | null
  >(null);
  const [isTogglingCapture, setIsTogglingCapture] = useState(false);

  useEffect(() => {
    // Update native title bar overlay on Windows
    const backgroundColor = effectiveTheme === "dark" ? "#09090b" : "#f1f5f9"; // slate-100 for light mode
    const symbolColor = effectiveTheme === "dark" ? "#ffffff" : "#475569"; // slate-600

    window.appApi
      .updateTitleBar({
        backgroundColor,
        symbolColor,
      })
      .catch(console.error);
  }, [effectiveTheme]);

  useEffect(() => {
    // Initial state check
    window.screenCaptureApi.getState().then((result) => {
      if (result.success && result.data) {
        setIsRecording(result.data.status === "running");
        setCaptureStatus(result.data.status);
      }
    });

    // Listen for state changes (Running/Paused/Stopped)
    const unsubState = window.screenCaptureApi.onStateChanged((payload) => {
      setIsRecording(payload.status === "running");
      setCaptureStatus(payload.status);
    });

    return () => {
      unsubState();
    };
  }, []);

  const handleToggleCapture = async () => {
    if (isTogglingCapture) return;

    setIsTogglingCapture(true);
    try {
      const before = await window.screenCaptureApi.getState();
      const status = before.success && before.data ? before.data.status : captureStatus;

      if (status === "running") {
        await window.screenCaptureApi.pause();
      } else if (status === "paused") {
        await window.screenCaptureApi.resume();
      } else {
        await window.screenCaptureApi.start();
      }

      const after = await window.screenCaptureApi.getState();
      if (after.success && after.data) {
        setIsRecording(after.data.status === "running");
        setCaptureStatus(after.data.status);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsTogglingCapture(false);
    }
  };

  return (
    <div
      className={cn(
        "h-[38px] w-full flex items-center px-4 shrink-0 select-none transition-colors duration-200 fixed top-0 z-99999",
        effectiveTheme === "dark" ? "bg-[#09090b]" : "bg-[#f1f5f9]",
        "border-b border-border/40",
        // This is crucial for Electron draggability
        "drag-region"
      )}
      style={
        {
          // Add a specific style to ensure draggability if the class isn't enough
          WebkitAppRegion: "drag",
        } as React.CSSProperties
      }
    >
      <div className="flex items-center gap-2">
        <img src="logo.png" alt="Mnemora" className="w-4 h-4" />
        <span className="text-xs font-medium text-muted-foreground opacity-80">Mnemora</span>
        {isRecording && (
          <div className="flex items-center gap-1.5 ml-2">
            <div
              className={cn(
                "w-2 h-2 rounded-full bg-red-500 animate-pulse transition-all duration-1000 opacity-80"
              )}
              style={{ animationDuration: "3s" }}
            />
            <span className="text-[10px] font-semibold text-red-500/80 uppercase tracking-wider">
              {t("nav.recording")}
            </span>
          </div>
        )}
      </div>

      {/* Spacing for Windows control buttons which are overlaid on the right */}
      <div className="flex-1" />
      <div
        className="flex items-center gap-2 h-full no-drag"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                onClick={handleToggleCapture}
                disabled={isTogglingCapture}
                className={cn(
                  "h-7 px-3 rounded-full text-xs",
                  isRecording
                    ? "border-green-500/30 bg-green-500/5 text-green-600 hover:bg-green-500/10 dark:text-green-400"
                    : "border-primary/20 bg-primary/5 text-primary hover:bg-primary/10"
                )}
              >
                {isTogglingCapture ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isRecording ? (
                  <PauseCircle className="h-3.5 w-3.5" />
                ) : captureStatus === "paused" ? (
                  <PlayCircle className="h-3.5 w-3.5" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
                <span>
                  {isRecording
                    ? t("activityMonitor.empty.pause", "Pause capture")
                    : captureStatus === "paused"
                      ? t("activityMonitor.empty.resume")
                      : t("activityMonitor.empty.start")}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isRecording
                ? t("activityMonitor.empty.pause", "Pause capture")
                : captureStatus === "paused"
                  ? t("activityMonitor.empty.resume")
                  : t("activityMonitor.empty.start")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="w-[120px] h-full" />
      </div>
    </div>
  );
};
