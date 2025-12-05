/**
 * ViewTransitionProvider and Context
 * Provides transition state management and reduced motion detection
 * Requirements: 3.1, 3.2, 3.3, 2.1, 2.2
 */

import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useTransition,
  type ReactNode,
} from "react";
import type { TransitionState, ViewTransitionContextValue } from "./types";

/**
 * Default context value for ViewTransitionContext
 */
const defaultContextValue: ViewTransitionContextValue = {
  transitionState: "idle",
  setTransitionState: () => {},
  prefersReducedMotion: false,
  isPending: false,
};

/**
 * Context for sharing transition state across components
 */
// eslint-disable-next-line react-refresh/only-export-components
export const ViewTransitionContext = createContext<ViewTransitionContextValue>(defaultContextValue);

/**
 * Props for ViewTransitionProvider
 */
interface ViewTransitionProviderProps {
  children: ReactNode;
}

/**
 * Provider component that manages view transition state
 * - Tracks current transition state (idle/transitioning)
 * - Detects and responds to prefers-reduced-motion preference
 * - Exposes isPending from useTransition for low-priority state updates
 * - Provides context to child components
 */
export function ViewTransitionProvider({ children }: ViewTransitionProviderProps) {
  const [transitionState, setTransitionStateInternal] = useState<TransitionState>("idle");
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Memoized setter to maintain stable reference
  // Uses startTransition to mark state updates as low priority
  const setTransitionState = useCallback((state: TransitionState) => {
    startTransition(() => {
      setTransitionStateInternal(state);
    });
  }, []);

  // Detect and listen for prefers-reduced-motion changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    // Set initial value
    setPrefersReducedMotion(mediaQuery.matches);

    // Listen for changes
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  const contextValue: ViewTransitionContextValue = {
    transitionState,
    setTransitionState,
    prefersReducedMotion,
    isPending,
  };

  return (
    <ViewTransitionContext.Provider value={contextValue}>{children}</ViewTransitionContext.Provider>
  );
}
