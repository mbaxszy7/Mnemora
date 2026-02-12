import { useState, useEffect, useRef } from "react";
import type { BootStatus, BootPhase } from "@shared/ipc-types";

// ---- Constants ----

export const SIMULATED_PHASES: BootPhase[] = [
  "db-init",
  "fts-check",
  "fts-rebuild",
  "app-init",
  "background-init",
];

export const SIMULATED_PHASE_DURATION_MS = 550;
export const SLOW_START_WARNING_THRESHOLD_MS = 4000;

const PHASE_PROGRESS: Record<BootPhase, number> = {
  "db-init": 15,
  "fts-check": 35,
  "fts-rebuild": 70,
  "app-init": 90,
  "background-init": 95,
  ready: 100,
  degraded: 100,
  failed: 0,
};

// ---- Pure helpers ----

export function isTerminalPhase(phase: BootPhase): boolean {
  return phase === "ready" || phase === "degraded" || phase === "failed";
}

export function getPhaseProgress(phase: BootPhase): number {
  return PHASE_PROGRESS[phase];
}

/**
 * Compute display phase and progress for the splash screen.
 *
 * - ready/degraded + simulation done → show real phase at 100%
 * - failed + simulation done → show "failed" phase but freeze progress at last simulated value
 * - otherwise → show the current simulated phase
 */
export function computeDisplayState(
  bootStatus: BootStatus | null,
  simulatedIndex: number,
  simulationDone: boolean
): { displayPhase: BootPhase; displayProgress: number } {
  const clampedIndex = Math.min(simulatedIndex, SIMULATED_PHASES.length - 1);
  const simulatedPhase = SIMULATED_PHASES[clampedIndex];

  if (bootStatus && isTerminalPhase(bootStatus.phase) && simulationDone) {
    const progress =
      bootStatus.phase === "failed"
        ? getPhaseProgress(simulatedPhase)
        : getPhaseProgress(bootStatus.phase);
    return { displayPhase: bootStatus.phase, displayProgress: progress };
  }

  return { displayPhase: simulatedPhase, displayProgress: getPhaseProgress(simulatedPhase) };
}

// ---- Hook ----

export interface BootProgressState {
  bootStatus: BootStatus | null;
  displayPhase: BootPhase;
  displayProgress: number;
  isTerminal: boolean;
  isFailed: boolean;
  isDegraded: boolean;
  showSlowWarning: boolean;
  showProgress: boolean;
  simulationDone: boolean;
}

export function useBootProgress(prefersReducedMotion: boolean): BootProgressState {
  // ---- Boot status subscription ----
  const [bootStatus, setBootStatus] = useState<BootStatus | null>(null);
  const terminalLockedRef = useRef(false);

  useEffect(() => {
    void window.bootApi.getStatus().then((result) => {
      if (result.success && result.data) {
        setBootStatus(result.data);
      }
    });

    const unsubscribe = window.bootApi.onStatusChanged((status) => {
      if (terminalLockedRef.current) return;
      if (isTerminalPhase(status.phase)) {
        terminalLockedRef.current = true;
      }
      setBootStatus(status);
    });

    return () => unsubscribe();
  }, []);

  // ---- Phase simulation ----
  const [simulatedIndex, setSimulatedIndex] = useState(0);
  const [simulationDone, setSimulationDone] = useState(false);
  const hasBootStatus = bootStatus !== null;

  useEffect(() => {
    if (!hasBootStatus) return;

    if (prefersReducedMotion) {
      setSimulatedIndex(SIMULATED_PHASES.length - 1);
      setSimulationDone(true);
      return;
    }

    let idx = 0;
    let active = true;
    setSimulatedIndex(0);
    setSimulationDone(false);

    const tick = () => {
      if (!active) return;
      if (idx >= SIMULATED_PHASES.length - 1) {
        setSimulationDone(true);
        return;
      }
      setTimeout(() => {
        if (!active) return;
        idx += 1;
        setSimulatedIndex(idx);
        tick();
      }, SIMULATED_PHASE_DURATION_MS);
    };

    tick();

    return () => {
      active = false;
    };
  }, [hasBootStatus, prefersReducedMotion]);

  // ---- Slow warning ----
  const [showSlowWarning, setShowSlowWarning] = useState(false);
  const bootPhase = bootStatus?.phase;

  useEffect(() => {
    if (!simulationDone) {
      setShowSlowWarning(false);
      return;
    }

    if (bootPhase && isTerminalPhase(bootPhase)) {
      setShowSlowWarning(false);
      return;
    }

    const timer = setTimeout(() => setShowSlowWarning(true), SLOW_START_WARNING_THRESHOLD_MS);
    return () => clearTimeout(timer);
  }, [simulationDone, bootPhase]);

  // ---- Derived state ----
  const { displayPhase, displayProgress } = computeDisplayState(
    bootStatus,
    simulatedIndex,
    simulationDone
  );

  return {
    bootStatus,
    displayPhase,
    displayProgress,
    isTerminal: bootStatus ? isTerminalPhase(bootStatus.phase) : false,
    isFailed: bootStatus?.phase === "failed",
    isDegraded: bootStatus?.phase === "degraded",
    showSlowWarning,
    showProgress: bootStatus !== null,
    simulationDone,
  };
}
