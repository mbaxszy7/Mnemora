/**
 * Property-based tests for useViewTransition hook
 * Tests correctness properties for reduced motion and transition state lifecycle
 * @vitest-environment jsdom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import fc from "fast-check";
import React from "react";
import { ViewTransitionProvider, ViewTransitionContext } from "./provider";
import {
  useViewTransition,
  injectTransitionCSS,
  cleanupTransitionCSS,
} from "./use-view-transition";
import type { TransitionType, TransitionState, ViewTransitionContextValue } from "./types";

// Mock react-router-dom
const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

// Valid transition types for testing
const animatedTransitionTypes: TransitionType[] = [
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "scale",
];

describe("useViewTransition Hook", () => {
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let mockStartViewTransition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNavigate.mockClear();

    // Mock matchMedia
    mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    window.matchMedia = mockMatchMedia as unknown as typeof window.matchMedia;

    // Mock startViewTransition
    mockStartViewTransition = vi.fn().mockImplementation((callback: () => void) => {
      callback();
      return {
        finished: Promise.resolve(),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
      };
    });
    document.startViewTransition =
      mockStartViewTransition as unknown as typeof document.startViewTransition;

    // Clean up any existing transition styles
    cleanupTransitionCSS();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTransitionCSS();
  });

  /**
   * **Feature: view-transition, Property 3: Reduced motion preference controls animation behavior**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For any navigation request, if `prefers-reduced-motion` is enabled,
   * the navigation should occur without calling `startViewTransition`;
   * otherwise, `startViewTransition` should be called.
   */
  test("**Feature: view-transition, Property 3: Reduced motion preference controls animation behavior**", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...animatedTransitionTypes),
        fc.boolean(),
        fc.string({ minLength: 1 }).filter((s) => s.startsWith("/")),
        async (type: TransitionType, prefersReducedMotion: boolean, path: string) => {
          mockNavigate.mockClear();
          mockStartViewTransition.mockClear();

          // Set up matchMedia to return the prefersReducedMotion value
          mockMatchMedia.mockImplementation((query: string) => ({
            matches: prefersReducedMotion,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }));

          const wrapper = ({ children }: { children: React.ReactNode }) =>
            React.createElement(ViewTransitionProvider, null, children);

          const { result } = renderHook(() => useViewTransition(), { wrapper });

          await act(async () => {
            result.current.navigate(path, { type });
          });

          // Navigation should always happen
          expect(mockNavigate).toHaveBeenCalledWith(path);

          if (prefersReducedMotion) {
            // When reduced motion is preferred, startViewTransition should NOT be called
            expect(mockStartViewTransition).not.toHaveBeenCalled();
          } else {
            // When reduced motion is not preferred, startViewTransition SHOULD be called
            expect(mockStartViewTransition).toHaveBeenCalled();
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test("type 'none' skips animation regardless of reduced motion preference", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.string({ minLength: 1 }).filter((s) => s.startsWith("/")),
        async (prefersReducedMotion: boolean, path: string) => {
          mockNavigate.mockClear();
          mockStartViewTransition.mockClear();

          mockMatchMedia.mockImplementation((query: string) => ({
            matches: prefersReducedMotion,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }));

          const wrapper = ({ children }: { children: React.ReactNode }) =>
            React.createElement(ViewTransitionProvider, null, children);

          const { result } = renderHook(() => useViewTransition(), { wrapper });

          await act(async () => {
            result.current.navigate(path, { type: "none" });
          });

          // Navigation should happen
          expect(mockNavigate).toHaveBeenCalledWith(path);

          // startViewTransition should NOT be called for 'none' type
          expect(mockStartViewTransition).not.toHaveBeenCalled();

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Feature: view-transition, Property 4: Transition state lifecycle**
   * **Validates: Requirements 3.2, 3.3**
   *
   * For any navigation with animation, the transition state should change from
   * 'idle' to 'transitioning' when navigation starts, and back to 'idle'
   * when the transition completes.
   */
  test("**Feature: view-transition, Property 4: Transition state lifecycle**", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...animatedTransitionTypes),
        fc.integer({ min: 100, max: 1000 }),
        fc.string({ minLength: 1 }).filter((s) => s.startsWith("/")),
        async (type: TransitionType, duration: number, path: string) => {
          mockNavigate.mockClear();

          const stateChanges: TransitionState[] = [];
          let resolveFinished: () => void;
          const finishedPromise = new Promise<void>((resolve) => {
            resolveFinished = resolve;
          });

          // Track state changes through a custom mock
          mockStartViewTransition.mockImplementation((callback: () => void) => {
            callback();
            return {
              finished: finishedPromise,
              ready: Promise.resolve(),
              updateCallbackDone: Promise.resolve(),
            };
          });

          // Create a custom provider that tracks state changes
          const TestProvider = ({ children }: { children: React.ReactNode }) => {
            const [transitionState, setTransitionStateInternal] =
              React.useState<TransitionState>("idle");

            const setTransitionState = React.useCallback((state: TransitionState) => {
              stateChanges.push(state);
              setTransitionStateInternal(state);
            }, []);

            const contextValue: ViewTransitionContextValue = {
              transitionState,
              setTransitionState,
              prefersReducedMotion: false,
            };

            return React.createElement(
              ViewTransitionContext.Provider,
              { value: contextValue },
              children
            );
          };

          const wrapper = ({ children }: { children: React.ReactNode }) =>
            React.createElement(TestProvider, null, children);

          const { result } = renderHook(() => useViewTransition(), { wrapper });

          // Start navigation
          await act(async () => {
            result.current.navigate(path, { type, duration });
          });

          // State should have changed to 'transitioning'
          expect(stateChanges).toContain("transitioning");

          // Complete the transition
          await act(async () => {
            resolveFinished!();
            // Allow promises to resolve
            await new Promise((resolve) => setTimeout(resolve, 0));
          });

          // State should have changed back to 'idle'
          expect(stateChanges[stateChanges.length - 1]).toBe("idle");

          // Verify the lifecycle: should go transitioning -> idle
          const transitioningIndex = stateChanges.indexOf("transitioning");
          const idleIndex = stateChanges.lastIndexOf("idle");
          expect(transitioningIndex).toBeLessThan(idleIndex);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test("CSS injection and cleanup utilities work correctly", () => {
    // Initially no style element
    expect(document.getElementById("view-transition-style")).toBeNull();

    // Inject CSS
    injectTransitionCSS("fade", 300);
    const styleElement = document.getElementById("view-transition-style");
    expect(styleElement).not.toBeNull();
    expect(styleElement?.textContent).toContain("--transition-duration: 300ms");

    // Cleanup removes the style
    cleanupTransitionCSS();
    expect(document.getElementById("view-transition-style")).toBeNull();
  });

  test("default options are applied when not specified", async () => {
    mockNavigate.mockClear();
    mockStartViewTransition.mockClear();

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(ViewTransitionProvider, null, children);

    const { result } = renderHook(() => useViewTransition(), { wrapper });

    await act(async () => {
      result.current.navigate("/test");
    });

    // Should use default fade animation
    expect(mockStartViewTransition).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/test");
  });

  test("handles numeric navigation (history back/forward)", async () => {
    mockNavigate.mockClear();

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(ViewTransitionProvider, null, children);

    const { result } = renderHook(() => useViewTransition(), { wrapper });

    await act(async () => {
      result.current.navigate(-1, { type: "none" });
    });

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
