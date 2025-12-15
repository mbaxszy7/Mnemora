import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Brain, Zap, Eye, ArrowRight, Pause, Play, Square } from "lucide-react";
import { PermissionBanner } from "@/components/core/PermissionBanner";

/**
 * Hook to initialize capture services once when permissions are granted
 */
function useInitServices() {
  const initializedRef = useRef(false);

  const initServices = async () => {
    if (initializedRef.current) return;
    try {
      const result = await window.captureSourceApi.initServices();
      if (result.success) {
        initializedRef.current = true;
        console.log("Capture services initialized");
      }
    } catch (error) {
      console.error("Failed to initialize capture services:", error);
    }
  };

  return { initServices };
}

// TEMPORARY: Screen capture control buttons - remove later
function ScreenCaptureControls() {
  const [status, setStatus] = useState<string>("idle");

  const refreshState = async () => {
    const result = await window.screenCaptureApi.getState();
    if (result.success && result.data) {
      setStatus(result.data.status);
    }
  };

  useEffect(() => {
    refreshState();
    const interval = setInterval(refreshState, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleStart = async () => {
    await window.screenCaptureApi.start();
    refreshState();
  };

  const handleStop = async () => {
    await window.screenCaptureApi.stop();
    refreshState();
  };

  const handlePause = async () => {
    await window.screenCaptureApi.pause();
    refreshState();
  };

  const handleResume = async () => {
    await window.screenCaptureApi.resume();
    refreshState();
  };

  return (
    <div className="p-4 rounded-lg border border-dashed border-yellow-500 bg-yellow-50 dark:bg-yellow-950">
      <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-3">
        ⚠️ TEMPORARY: Screen Capture Controls (Status: {status})
      </p>
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" onClick={handleStart} disabled={status === "running"}>
          <Play className="w-4 h-4 mr-1" /> Start
        </Button>
        <Button size="sm" onClick={handlePause} disabled={status !== "running"}>
          <Pause className="w-4 h-4 mr-1" /> Pause
        </Button>
        <Button size="sm" onClick={handleResume} disabled={status !== "paused"}>
          <Play className="w-4 h-4 mr-1" /> Resume
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={handleStop}
          disabled={status === "idle" || status === "stopped"}
        >
          <Square className="w-4 h-4 mr-1" /> Stop
        </Button>
      </div>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const { initServices } = useInitServices();

  // Initialize services when page loads (if permissions are already granted)
  useEffect(() => {
    initServices();
  }, [initServices]);

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Permission Banner */}
      <PermissionBanner onPermissionGranted={initServices} />

      {/* TEMPORARY: Screen Capture Controls */}
      <ScreenCaptureControls />

      {/* Hero */}
      <div className="text-center space-y-4 py-8">
        <div className="flex items-center justify-center gap-3">
          <Brain className="w-16 h-16 text-primary" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight">Turn Your Screen Into a Second Brain</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Mnemora is an intelligent context-aware desktop app that continuously understands your
          screen content, providing real-time insights and smart suggestions.
        </p>
        <div className="flex justify-center gap-4 pt-4">
          <Button size="lg" onClick={() => navigate("/about")}>
            Learn More
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate("/settings")}>
            Get Started
          </Button>
        </div>
      </div>

      {/* Features */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="p-6 rounded-lg border bg-card">
          <Eye className="w-10 h-10 text-primary mb-4" />
          <h3 className="text-xl font-semibold mb-2">Screen Awareness</h3>
          <p className="text-muted-foreground">
            Continuous screen perception and semantic understanding, automatically recognizing the
            content and context you're working with.
          </p>
        </div>
        <div className="p-6 rounded-lg border bg-card">
          <Zap className="w-10 h-10 text-primary mb-4" />
          <h3 className="text-xl font-semibold mb-2">Smart Insights</h3>
          <p className="text-muted-foreground">
            Context-based real-time insights and intelligent suggestions to help you work more
            efficiently.
          </p>
        </div>
      </div>
    </div>
  );
}
