/**
 * CSS Animation Presets for View Transitions
 * Provides predefined CSS animations for each transition type
 * Requirements: 4.1, 4.2
 */

import type { TransitionType } from "./types";

/**
 * Base CSS to disable root transition and prevent flicker
 * Applied to all transition types
 */
const baseTransitionCSS = `
    ::view-transition-old(root),
    ::view-transition-new(root) {
      animation: none;
      mix-blend-mode: normal;
    }
    ::view-transition-group(main-content) {
      isolation: isolate;
    }
    ::view-transition-image-pair(main-content) {
      isolation: isolate;
    }
`;

/**
 * CSS animation presets for each transition type
 * Uses View Transitions API pseudo-elements
 * Targets 'main-content' to avoid animating persistent elements like Navbar
 */
export const transitionPresets: Record<TransitionType, string> = {
  fade: `
    ${baseTransitionCSS}
    ::view-transition-old(main-content) {
      animation: fade-out var(--transition-duration) ease-in-out both;
    }
    ::view-transition-new(main-content) {
      animation: fade-in var(--transition-duration) ease-in-out both;
    }
    @keyframes fade-out {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `,

  "slide-left": `
    ${baseTransitionCSS}
    ::view-transition-old(main-content) {
      animation: slide-out-left var(--transition-duration) ease-in-out both;
    }
    ::view-transition-new(main-content) {
      animation: slide-in-left var(--transition-duration) ease-in-out both;
    }
    @keyframes slide-out-left {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(-30%); opacity: 0; }
    }
    @keyframes slide-in-left {
      from { transform: translateX(30%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `,

  "slide-right": `
    ${baseTransitionCSS}
    ::view-transition-old(main-content) {
      animation: slide-out-right var(--transition-duration) ease-in-out both;
    }
    ::view-transition-new(main-content) {
      animation: slide-in-right var(--transition-duration) ease-in-out both;
    }
    @keyframes slide-out-right {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(30%); opacity: 0; }
    }
    @keyframes slide-in-right {
      from { transform: translateX(-30%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `,

  "slide-up": `
    ${baseTransitionCSS}
    ::view-transition-old(main-content) {
      animation: slide-out-up var(--transition-duration) ease-in-out both;
    }
    ::view-transition-new(main-content) {
      animation: slide-in-up var(--transition-duration) ease-in-out both;
    }
    @keyframes slide-out-up {
      from { transform: translateY(0); opacity: 1; }
      to { transform: translateY(-30%); opacity: 0; }
    }
    @keyframes slide-in-up {
      from { transform: translateY(30%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `,

  "slide-down": `
    ${baseTransitionCSS}
    ::view-transition-old(main-content) {
      animation: slide-out-down var(--transition-duration) ease-in-out both;
    }
    ::view-transition-new(main-content) {
      animation: slide-in-down var(--transition-duration) ease-in-out both;
    }
    @keyframes slide-out-down {
      from { transform: translateY(0); opacity: 1; }
      to { transform: translateY(30%); opacity: 0; }
    }
    @keyframes slide-in-down {
      from { transform: translateY(-30%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `,

  scale: `
    ${baseTransitionCSS}
    ::view-transition-old(main-content) {
      animation: scale-out var(--transition-duration) ease-in-out both;
    }
    ::view-transition-new(main-content) {
      animation: scale-in var(--transition-duration) ease-in-out both;
    }
    @keyframes scale-out {
      from { transform: scale(1); opacity: 1; }
      to { transform: scale(0.9); opacity: 0; }
    }
    @keyframes scale-in {
      from { transform: scale(1.1); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
  `,

  "splash-fade": `
    ::view-transition-old(root) {
      animation: splash-fade-out var(--transition-duration) ease-in-out both;
    }
    ::view-transition-new(root) {
      animation: splash-fade-in var(--transition-duration) ease-in-out both;
    }
    @keyframes splash-fade-out {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    @keyframes splash-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `,

  none: "",
};

/**
 * Generates CSS with the transition duration variable set
 * @param type - The transition type
 * @param duration - Duration in milliseconds
 * @returns CSS string with duration variable and animation rules
 */
export function getTransitionCSS(type: TransitionType, duration: number): string {
  const preset = transitionPresets[type];

  if (!preset) {
    return "";
  }

  // Wrap the preset CSS with the duration variable
  return `:root { --transition-duration: ${duration}ms; }\n${preset}`;
}
