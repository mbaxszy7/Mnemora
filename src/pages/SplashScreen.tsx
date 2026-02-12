import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import { useViewTransition } from "@/components/core/view-transition";
import { useTranslation } from "react-i18next";
import type { BootPhase } from "@shared/ipc-types";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useBootProgress } from "@/hooks/use-boot-progress";
import { useLlmConfigCheck, type ConfigCheckStatus } from "@/hooks/use-llm-config-check";

const SLOGANS = ["Pixels to memory.", "Memory, amplified.", "Remember everything."] as const;
const MIN_PHASE_DURATION_MS = 1500;

export function getNavigationTarget(status: ConfigCheckStatus): string {
  return status === "not_configured" ? "/llm-config" : "/";
}

export default function SplashScreen() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();
  const prefersReducedMotion = usePrefersReducedMotion();

  const boot = useBootProgress(prefersReducedMotion);
  const configCheck = useLlmConfigCheck();

  // ---- Slogan rotation ----
  const [currentSloganIndex, setCurrentSloganIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentSloganIndex((prev) => (prev + 1) % SLOGANS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // ---- Navigate when ready ----
  const [hasNavigated, setHasNavigated] = useState(false);
  const mountedAtRef = useRef(Date.now());

  useEffect(() => {
    if (hasNavigated || !boot.bootStatus || !configCheck.checked) return;
    if (boot.isFailed || !boot.isTerminal || !boot.simulationDone) return;

    const elapsed = Date.now() - mountedAtRef.current;
    const remaining = Math.max(0, MIN_PHASE_DURATION_MS - elapsed);

    const timer = setTimeout(() => {
      setHasNavigated(true);
      const target = getNavigationTarget(configCheck.status);
      navigate(target, { type: "splash-fade", duration: 900 });
    }, remaining);

    return () => clearTimeout(timer);
  }, [
    boot.bootStatus,
    boot.isTerminal,
    boot.isFailed,
    boot.simulationDone,
    configCheck,
    navigate,
    hasNavigated,
  ]);

  const handleRetry = () => {
    void window.bootApi.relaunch();
  };

  const getStatusMessage = () => {
    const phaseMessages: Record<BootPhase, string> = {
      "db-init": t("boot.phase.dbInit"),
      "fts-check": t("boot.phase.ftsCheck"),
      "fts-rebuild": t("boot.phase.ftsRebuild"),
      "app-init": t("boot.phase.appInit"),
      "background-init": t("boot.phase.backgroundInit"),
      ready: t("boot.phase.ready"),
      degraded: t("boot.phase.degraded"),
      failed: t("boot.phase.failed"),
    };
    return phaseMessages[boot.displayPhase];
  };

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: prefersReducedMotion ? 1 : 0 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.5 }}
      className="fixed inset-0 flex flex-col items-center justify-start bg-background pt-[120px]"
    >
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

      <h1 className="text-foreground text-[64px] font-bold tracking-tight text-center font-sans">
        Mnemora
      </h1>

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

      {boot.showProgress && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.5 }}
          className="mt-12 w-80 flex flex-col items-center gap-3"
        >
          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-500"
              initial={{ width: 0 }}
              animate={{ width: `${boot.displayProgress}%` }}
              transition={{ duration: 0 }}
            />
          </div>

          <div className="flex flex-col items-center gap-1">
            <span className="text-sm text-muted-foreground">{getStatusMessage()}</span>

            {boot.isDegraded && (
              <span className="text-xs text-amber-500">{t("boot.warning.degraded")}</span>
            )}
            {boot.isFailed && (
              <span className="text-xs text-destructive">{t("boot.error.failed")}</span>
            )}
          </div>

          {boot.showSlowWarning && !boot.isTerminal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center gap-2 mt-2"
            >
              <span className="text-xs text-muted-foreground">
                {t("boot.slowWarning", "Initialization is taking longer than expected...")}
              </span>
            </motion.div>
          )}

          {boot.isFailed && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-3 mt-4"
            >
              <span className="text-xs text-destructive text-center max-w-[280px]">
                {boot.bootStatus?.errorMessage ||
                  t("boot.error.default", "Failed to start application")}
              </span>
              <Button variant="outline" size="sm" onClick={handleRetry} className="gap-2">
                <RotateCcw className="w-4 h-4" />
                {t("boot.retry", "Retry")}
              </Button>
            </motion.div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
