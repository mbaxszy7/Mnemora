import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  isTerminalPhase,
  getPhaseProgress,
  computeDisplayState,
  SIMULATED_PHASES,
} from "./use-boot-progress";
import type { BootPhase, BootStatus } from "@shared/ipc-types";

const ALL_PHASES: BootPhase[] = [
  "db-init",
  "fts-check",
  "fts-rebuild",
  "app-init",
  "background-init",
  "ready",
  "degraded",
  "failed",
];

const TERMINAL_PHASES: BootPhase[] = ["ready", "degraded", "failed"];
const NON_TERMINAL_PHASES: BootPhase[] = [
  "db-init",
  "fts-check",
  "fts-rebuild",
  "app-init",
  "background-init",
];

function makeBootStatus(phase: BootPhase, errorMessage?: string): BootStatus {
  return {
    phase,
    progress: 0,
    messageKey: "boot.phase.dbInit",
    timestamp: Date.now(),
    ...(errorMessage && { errorMessage }),
  };
}

describe("isTerminalPhase", () => {
  it("returns true for terminal phases", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TERMINAL_PHASES), (phase) => {
        expect(isTerminalPhase(phase)).toBe(true);
      })
    );
  });

  it("returns false for non-terminal phases", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NON_TERMINAL_PHASES), (phase) => {
        expect(isTerminalPhase(phase)).toBe(false);
      })
    );
  });

  it("is deterministic for any phase", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_PHASES), (phase) => {
        expect(isTerminalPhase(phase)).toBe(isTerminalPhase(phase));
      })
    );
  });
});

describe("getPhaseProgress", () => {
  it("returns a number between 0 and 100 for all phases", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_PHASES), (phase) => {
        const progress = getPhaseProgress(phase);
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThanOrEqual(100);
      })
    );
  });

  it("returns 100 for ready and degraded", () => {
    expect(getPhaseProgress("ready")).toBe(100);
    expect(getPhaseProgress("degraded")).toBe(100);
  });

  it("returns monotonically increasing progress for simulated phases", () => {
    for (let i = 1; i < SIMULATED_PHASES.length; i++) {
      expect(getPhaseProgress(SIMULATED_PHASES[i])).toBeGreaterThanOrEqual(
        getPhaseProgress(SIMULATED_PHASES[i - 1])
      );
    }
  });
});

describe("computeDisplayState", () => {
  it("returns simulated phase when no boot status", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SIMULATED_PHASES.length - 1 }),
        fc.boolean(),
        (idx, done) => {
          const result = computeDisplayState(null, idx, done);
          expect(result.displayPhase).toBe(SIMULATED_PHASES[idx]);
          expect(result.displayProgress).toBe(getPhaseProgress(SIMULATED_PHASES[idx]));
        }
      )
    );
  });

  it("returns simulated phase when simulation is not done", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_PHASES),
        fc.integer({ min: 0, max: SIMULATED_PHASES.length - 1 }),
        (phase, idx) => {
          const status = makeBootStatus(phase);
          const result = computeDisplayState(status, idx, false);
          expect(result.displayPhase).toBe(SIMULATED_PHASES[idx]);
        }
      )
    );
  });

  it("returns real phase at 100% for ready/degraded when simulation done", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("ready" as BootPhase, "degraded" as BootPhase),
        fc.integer({ min: 0, max: SIMULATED_PHASES.length - 1 }),
        (phase, idx) => {
          const status = makeBootStatus(phase);
          const result = computeDisplayState(status, idx, true);
          expect(result.displayPhase).toBe(phase);
          expect(result.displayProgress).toBe(100);
        }
      )
    );
  });

  it("does NOT show 100% progress for failed state", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: SIMULATED_PHASES.length - 1 }), (idx) => {
        const status = makeBootStatus("failed", "DB error");
        const result = computeDisplayState(status, idx, true);
        expect(result.displayPhase).toBe("failed");
        expect(result.displayProgress).toBeLessThan(100);
        expect(result.displayProgress).toBe(
          getPhaseProgress(SIMULATED_PHASES[Math.min(idx, SIMULATED_PHASES.length - 1)])
        );
      })
    );
  });

  it("clamps simulated index to valid range", () => {
    fc.assert(
      fc.property(fc.integer({ min: SIMULATED_PHASES.length, max: 999 }), (idx) => {
        const result = computeDisplayState(null, idx, false);
        expect(result.displayPhase).toBe(SIMULATED_PHASES[SIMULATED_PHASES.length - 1]);
      })
    );
  });

  it("returns non-terminal simulated phase when boot is non-terminal and simulation done", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_TERMINAL_PHASES),
        fc.integer({ min: 0, max: SIMULATED_PHASES.length - 1 }),
        (phase, idx) => {
          const status = makeBootStatus(phase);
          const result = computeDisplayState(status, idx, true);
          expect(result.displayPhase).toBe(SIMULATED_PHASES[idx]);
        }
      )
    );
  });
});
