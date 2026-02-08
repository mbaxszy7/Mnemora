import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import { useViewTransition } from "@/components/core/view-transition";
import { useTranslation } from "react-i18next";
import type { BootStatus, BootPhase } from "@shared/ipc-types";

const SLOGANS = ["Pixels to memory.", "Memory, amplified.", "Remember everything."] as const;

/**
 * Boot phase progress mapping
 */
const BOOT_PHASE_PROGRESS: Record<BootPhase, number> = {
  "db-init": 15,
  "fts-check": 35,
  "fts-rebuild": 70,
  "app-init": 90,
  ready: 100,
  degraded: 100,
  failed: 100,
};

/**
 * Determines the navigation target based on LLM configuration check result
 */
export function getNavigationTarget(configured: boolean): string {
  return configured ? "/" : "/llm-config";
}

export default function SplashScreen() {
  const { t } = useTranslation();
  const [currentSloganIndex, setCurrentSloganIndex] = useState(0);
  const { navigate } = useViewTransition();

  // Boot status state
  const [bootStatus, setBootStatus] = useState<BootStatus | null>(null);
  const [hasNavigated, setHasNavigated] = useState(false);

  // LLM configuration check state
  const [configCheckResult, setConfigCheckResult] = useState<{
    checked: boolean;
    configured: boolean;
  }>({ checked: false, configured: false });
  const configCheckRef = useRef(false);

  // Detect prefers-reduced-motion
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Subscribe to boot status changes
  useEffect(() => {
    // Get initial status
    void window.bootApi.getStatus().then((result) => {
      if (result.success && result.data) {
        setBootStatus(result.data);
      }
    });

    // Subscribe to updates
    const unsubscribe = window.bootApi.onStatusChanged((status) => {
      setBootStatus(status);
    });

    return () => unsubscribe();
  }, []);

  // Check LLM configuration on mount
  useEffect(() => {
    if (configCheckRef.current) return;
    configCheckRef.current = true;

    const checkConfig = async () => {
      try {
        const result = await window.llmConfigApi.check();
        setConfigCheckResult({ checked: true, configured: result.configured });
      } catch (error) {
        console.error("Failed to check LLM configuration:", error);
        setConfigCheckResult({ checked: true, configured: false });
      }
    };

    // Preload 24 hours of timeline data during splash screen
    const preloadTimeline = async () => {
      try {
        const now = Date.now();
        const fromTs = now - 24 * 60 * 60 * 1000;
        await window.activityMonitorApi.getTimeline({ fromTs, toTs: now });
      } catch (error) {
        console.error("Failed to preload timeline:", error);
      }
    };

    checkConfig();
    preloadTimeline();
  }, []);

  // Slogan rotation effect
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentSloganIndex((prev) => (prev + 1) % SLOGANS.length);
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // Navigate when boot is ready/degraded AND config check is complete
  useEffect(() => {
    if (hasNavigated) return;
    if (!bootStatus) return;
    if (!configCheckResult.checked) return;

    const shouldNavigate = bootStatus.phase === "ready" || bootStatus.phase === "degraded";

    if (shouldNavigate) {
      setHasNavigated(true);
      const target = getNavigationTarget(configCheckResult.configured);
      navigate(target, { type: "splash-fade", duration: 900 });
    }
  }, [bootStatus, configCheckResult, navigate, hasNavigated]);

  // Calculate progress
  const progress = bootStatus ? BOOT_PHASE_PROGRESS[bootStatus.phase] : 0;
  const isDegraded = bootStatus?.phase === "degraded";
  const isFailed = bootStatus?.phase === "failed";
  const showProgress = bootStatus && bootStatus.phase !== "ready";

  // Get status message
  const getStatusMessage = () => {
    if (!bootStatus) return t("boot.phase.initializing" as "common.messages.loading");
    if (bootStatus.messageKey) {
      // Use the messageKey directly - type cast for new translation keys
      return t(bootStatus.messageKey as "common.messages.loading");
    }
    // Map phase to message key with fallback
    const phaseMessages: Record<BootPhase, string> = {
      "db-init": t("boot.phase.dbInit" as "common.messages.loading"),
      "fts-check": t("boot.phase.ftsCheck" as "common.messages.loading"),
      "fts-rebuild": t("boot.phase.ftsRebuild" as "common.messages.loading"),
      "app-init": t("boot.phase.appInit" as "common.messages.loading"),
      ready: t("boot.phase.ready" as "common.messages.loading"),
      degraded: t("boot.phase.degraded" as "common.messages.loading"),
      failed: t("boot.phase.failed" as "common.messages.loading"),
    };
    return phaseMessages[bootStatus.phase];
  };

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: prefersReducedMotion ? 1 : 0 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.5 }}
      className="fixed inset-0 flex flex-col items-center justify-start bg-background pt-[120px]"
    >
      {/* Logo with animation */}
      <motion.div
        initial={prefersReducedMotion ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: prefersReducedMotion ? 0 : 1 }}
        className="mb-8"
        role="img"
        aria-label="Mnemora logo"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 512 260"
          fill="none"
          className="w-64 h-auto"
        >
          <defs>
            <linearGradient id="neural_gradient_splash" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#6366F1" />
              <stop offset="50%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#06B6D4" />
            </linearGradient>
          </defs>
          <path
            d="M 100 380 V 200 C 100 100, 220 100, 256 220 C 292 100, 412 100, 412 200 V 380"
            stroke="url(#neural_gradient_splash)"
            strokeWidth="56"
            strokeLinecap="round"
            strokeLinejoin="round"
            transform="translate(0, -100)"
          />
          <circle cx="256" cy="50" r="32" fill="#06B6D4" />
        </svg>
      </motion.div>

      {/* Brand Name */}
      <h1 className="text-foreground text-[64px] font-bold tracking-tight text-center font-sans">
        Mnemora
      </h1>

      {/* Slogan Carousel */}
      <div className="relative h-12 mt-8 flex items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.p
            key={currentSloganIndex}
            initial={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -20 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.6 }}
            className="absolute text-muted-foreground text-base text-center whitespace-nowrap"
          >
            {SLOGANS[currentSloganIndex]}
          </motion.p>
        </AnimatePresence>
      </div>

      {/* Boot Progress Section */}
      {showProgress && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.5 }}
          className="mt-12 w-80 flex flex-col items-center gap-3"
        >
          {/* Progress Bar */}
          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-500"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
          </div>

          {/* Status Text */}
          <div className="flex flex-col items-center gap-1">
            <span className="text-sm text-muted-foreground">{getStatusMessage()}</span>

            {/* Error indicators */}
            {isDegraded && (
              <span className="text-xs text-amber-500">
                {t("boot.warning.degraded" as "common.messages.loading")}
              </span>
            )}
            {isFailed && (
              <span className="text-xs text-destructive">
                {t("boot.error.failed" as "common.messages.loading")}
              </span>
            )}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
