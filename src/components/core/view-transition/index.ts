/**
 * View Transition Module
 * Provides architecture-level view transition capabilities for React Router navigation
 *
 * Exports:
 * - Types: TransitionType, TransitionState, TransitionOptions, ViewTransitionContextValue, ViewTransitionNavigate, TransitionLinkProps
 * - Hooks: useViewTransition, useTransitionState
 * - Components: ViewTransitionProvider, ViewTransitionContext, TransitionNavLink
 * - Utilities: getTransitionCSS, transitionPresets, getReverseTransition
 *
 * Requirements: 1.1, 3.4, 5.1
 */

// Type exports
export type {
  TransitionType,
  TransitionState,
  TransitionOptions,
  ViewTransitionContextValue,
  ViewTransitionNavigate,
  TransitionLinkProps,
} from "./types";

// Hook exports
export { useViewTransition, getReverseTransition } from "./use-view-transition";
export { useTransitionState } from "./use-transition-state";

// Provider exports
export { ViewTransitionProvider, ViewTransitionContext } from "./provider";

// Component exports
export { TransitionNavLink } from "./transition-link";

// Utility exports
export { getTransitionCSS, transitionPresets } from "./presets";
