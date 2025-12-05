/**
 * useViewTransition Hook
 * Provides navigation with View Transitions API support
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.3
 */

import { useCallback, useContext } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ViewTransitionContext } from "./provider";
import { getReverseTransition, startViewTransition } from "./transition-core";
import type { TransitionType, ViewTransitionNavigate } from "./types";

// Re-export for backward compatibility
export { cleanupTransitionCSS, getReverseTransition, injectTransitionCSS } from "./transition-core";

/**
 * Hook that provides navigation with View Transitions API support
 * @returns Object containing navigate function and isPending state
 */
export function useViewTransition(): { navigate: ViewTransitionNavigate; isPending: boolean } {
  const routerNavigate = useNavigate();
  const location = useLocation();
  const { transitionState, setTransitionState, prefersReducedMotion, isPending } =
    useContext(ViewTransitionContext);

  // Derive isTransitioning from transitionState for blocking duplicate navigations
  const isTransitioning = transitionState === "transitioning";

  const navigate: ViewTransitionNavigate = useCallback(
    (to, options = {}) => {
      const { type = "fade", duration = 300 } = options;

      // Prevent navigation if a transition is already in progress
      if (isTransitioning) {
        return;
      }

      // Skip navigation if already on the same route (only for string paths)
      if (typeof to === "string" && location.pathname === to) {
        return;
      }

      // Determine if this is a back navigation (negative number)
      const isBackNavigation = typeof to === "number" && to < 0;

      // Use reverse transition for back navigation
      const effectiveType: TransitionType = isBackNavigation ? getReverseTransition(type) : type;

      // Helper to perform navigation with correct type
      const doNavigate = () => {
        if (typeof to === "number") {
          routerNavigate(to);
        } else {
          routerNavigate(to);
        }
      };

      // Skip animation if reduced motion preference or type is 'none'
      if (prefersReducedMotion || effectiveType === "none") {
        doNavigate();
        return;
      }

      startViewTransition({
        type: effectiveType,
        duration,
        onNavigate: doNavigate,
        onStateChange: setTransitionState,
      });
    },
    [routerNavigate, location.pathname, setTransitionState, prefersReducedMotion, isTransitioning]
  );

  return { navigate, isPending: isPending || isTransitioning };
}
