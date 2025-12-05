/**
 * Core View Transition utilities
 * Shared logic for view transitions used by both hook and component
 */

import { getTransitionCSS } from "./presets";
import type { TransitionType } from "./types";

// Style element ID for transition CSS
const TRANSITION_STYLE_ID = "view-transition-style";

/**
 * Maps transition types to their reverse counterparts
 * Used for back navigation to provide intuitive animations
 */
const reverseTransitionMap: Record<TransitionType, TransitionType> = {
  "slide-left": "slide-right",
  "slide-right": "slide-left",
  "slide-up": "slide-down",
  "slide-down": "slide-up",
  fade: "fade",
  scale: "scale",
  "splash-fade": "splash-fade",
  none: "none",
};

/**
 * Gets the reverse transition type for back navigation
 */
export function getReverseTransition(type: TransitionType): TransitionType {
  return reverseTransitionMap[type];
}

/**
 * Injects transition CSS into the document head
 */
export function injectTransitionCSS(type: TransitionType, duration: number): void {
  cleanupTransitionCSS();

  const css = getTransitionCSS(type ?? "fade", duration);
  if (!css) return;

  const style = document.createElement("style");
  style.id = TRANSITION_STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Removes transition CSS from the document head
 */
export function cleanupTransitionCSS(): void {
  const existingStyle = document.getElementById(TRANSITION_STYLE_ID);
  if (existingStyle) {
    existingStyle.remove();
  }
}

export interface StartTransitionOptions {
  type: TransitionType;
  duration: number;
  onNavigate: () => void;
  onStateChange: (state: "transitioning" | "idle") => void;
}

/**
 * Core function to start a view transition
 * Handles CSS injection, transition lifecycle, and cleanup
 */
export function startViewTransition(options: StartTransitionOptions): void {
  const { type, duration, onNavigate, onStateChange } = options;

  // Check if View Transitions API is available
  if (!document.startViewTransition) {
    onNavigate();
    return;
  }

  // Inject CSS for the transition
  injectTransitionCSS(type, duration);
  onStateChange("transitioning");

  // Start the view transition with async callback to ensure DOM updates are captured
  const transition = document.startViewTransition(async () => {
    onNavigate();
    // Wait for React to flush DOM updates
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Handle transition completion
  transition.finished
    .then(() => {
      onStateChange("idle");
      cleanupTransitionCSS();
    })
    .catch(() => {
      // Transition was skipped or failed, still cleanup
      onStateChange("idle");
      cleanupTransitionCSS();
    });
}
