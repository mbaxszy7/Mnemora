import React, { useEffect, useState } from "react";
import { useTheme } from "@/providers/theme-provider";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export const TitleBar: React.FC = () => {
  const { effectiveTheme } = useTheme();
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isCapturingAction, setIsCapturingAction] = useState(false);

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
      }
    });

    // Listen for state changes (Running/Paused/Stopped)
    const unsubState = window.screenCaptureApi.onStateChanged((payload) => {
      setIsRecording(payload.status === "running");
    });

    // Listen for actual capture pulses (the "taking a screenshot" action)
    const unsubStarted = window.screenCaptureApi.onCapturingStarted(() =>
      setIsCapturingAction(true)
    );
    const unsubFinished = window.screenCaptureApi.onCapturingFinished(() =>
      setIsCapturingAction(false)
    );

    return () => {
      unsubState();
      unsubStarted();
      unsubFinished();
    };
  }, []);

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
                "w-2 h-2 rounded-full bg-red-500 animate-pulse transition-all duration-1000",
                isCapturingAction ? "scale-125 shadow-[0_0_8px_rgba(239,68,68,0.6)]" : "opacity-80"
              )}
              style={{
                // Smoother breathing effect by lengthening the pulse period
                animationDuration: isCapturingAction ? "1s" : "3s",
              }}
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
        className="w-[120px] h-full no-drag"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      />
    </div>
  );
};
