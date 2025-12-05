/**
 * View Transition Type Definitions
 * Provides TypeScript types for the view transition system
 * Requirements: 5.1, 5.2, 5.3
 */

/**
 * Available transition animation types
 */
export type TransitionType =
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "scale"
  | "splash-fade"
  | "none";

/**
 * Transition state machine states
 * - idle: No transition in progress
 * - transitioning: Transition animation in progress
 */
export type TransitionState = "idle" | "transitioning";

/**
 * Configuration options for view transitions
 */
export interface TransitionOptions {
  /** Animation type, defaults to 'fade' */
  type?: TransitionType;
  /** Animation duration in milliseconds, defaults to 300 */
  duration?: number;
}

/**
 * Props for TransitionLink component
 */
export interface TransitionLinkProps extends TransitionOptions {
  /** Target path */
  to: string;
  /** Children elements */
  children: React.ReactNode;
  /** Additional class names */
  className?: string | ((props: { isActive: boolean; isPending: boolean }) => string);
  /** Whether to match exact path (for NavLink) */
  end?: boolean;
}

/**
 * Context value provided by ViewTransitionProvider
 */
export interface ViewTransitionContextValue {
  /** Current transition state */
  transitionState: TransitionState;
  /** Function to update transition state */
  setTransitionState: (state: TransitionState) => void;
  /** Whether user prefers reduced motion */
  prefersReducedMotion: boolean;
  /** Whether a transition state update is pending (from useTransition) */
  isPending: boolean;
}

/**
 * Navigate function type with transition support
 * @param to - Target path or history delta (number for back/forward)
 * @param options - Optional transition configuration
 */
export type ViewTransitionNavigate = (to: string | number, options?: TransitionOptions) => void;
