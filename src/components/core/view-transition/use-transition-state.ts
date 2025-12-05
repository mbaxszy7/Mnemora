/**
 * useTransitionState Hook
 * Provides access to current transition state from context
 * Requirements: 3.4
 */

import { useContext } from "react";
import { ViewTransitionContext } from "./provider";
import type { TransitionState } from "./types";

/**
 * Hook to access the current transition state
 * @returns Current transition state ('idle' or 'transitioning')
 */
export function useTransitionState(): TransitionState {
  const { transitionState } = useContext(ViewTransitionContext);
  return transitionState;
}
