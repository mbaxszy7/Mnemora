/**
 * Unit tests for ViewTransitionProvider and useTransitionState
 * Requirements: 3.1, 3.4
 * @vitest-environment jsdom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useContext } from "react";
import { ViewTransitionProvider, ViewTransitionContext } from "./provider";
import { useTransitionState } from "./use-transition-state";

// Test component to access context values
function TestConsumer() {
  const { transitionState, prefersReducedMotion } = useContext(ViewTransitionContext);
  return (
    <div>
      <span data-testid="state">{transitionState}</span>
      <span data-testid="reduced-motion">{prefersReducedMotion.toString()}</span>
    </div>
  );
}

// Test component for useTransitionState hook
function TransitionStateConsumer() {
  const state = useTransitionState();
  return <span data-testid="hook-state">{state}</span>;
}

// Test component that can update state
function StateUpdater() {
  const { transitionState, setTransitionState } = useContext(ViewTransitionContext);
  return (
    <div>
      <span data-testid="updater-state">{transitionState}</span>
      <button onClick={() => setTransitionState("transitioning")}>Start</button>
      <button onClick={() => setTransitionState("idle")}>End</button>
    </div>
  );
}

describe("ViewTransitionProvider", () => {
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let mediaQueryListeners: ((event: MediaQueryListEvent) => void)[] = [];

  beforeEach(() => {
    mediaQueryListeners = [];
    mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaQueryListeners.push(listener);
      },
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
        const index = mediaQueryListeners.indexOf(listener);
        if (index > -1) mediaQueryListeners.splice(index, 1);
      },
    }));
    window.matchMedia = mockMatchMedia;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders children correctly", () => {
    render(
      <ViewTransitionProvider>
        <div data-testid="child">Child Content</div>
      </ViewTransitionProvider>
    );

    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getByText("Child Content")).toBeInTheDocument();
  });

  test("initial transition state is idle", () => {
    render(
      <ViewTransitionProvider>
        <TestConsumer />
      </ViewTransitionProvider>
    );

    expect(screen.getByTestId("state")).toHaveTextContent("idle");
  });

  test("provides setTransitionState that updates state", async () => {
    render(
      <ViewTransitionProvider>
        <StateUpdater />
      </ViewTransitionProvider>
    );

    expect(screen.getByTestId("updater-state")).toHaveTextContent("idle");

    await act(async () => {
      screen.getByText("Start").click();
    });

    expect(screen.getByTestId("updater-state")).toHaveTextContent("transitioning");

    await act(async () => {
      screen.getByText("End").click();
    });

    expect(screen.getByTestId("updater-state")).toHaveTextContent("idle");
  });

  test("detects prefers-reduced-motion preference", () => {
    mockMatchMedia.mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(
      <ViewTransitionProvider>
        <TestConsumer />
      </ViewTransitionProvider>
    );

    expect(screen.getByTestId("reduced-motion")).toHaveTextContent("true");
  });

  test("responds to prefers-reduced-motion changes", async () => {
    render(
      <ViewTransitionProvider>
        <TestConsumer />
      </ViewTransitionProvider>
    );

    expect(screen.getByTestId("reduced-motion")).toHaveTextContent("false");

    // Simulate media query change
    await act(async () => {
      mediaQueryListeners.forEach((listener) => {
        listener({ matches: true } as MediaQueryListEvent);
      });
    });

    expect(screen.getByTestId("reduced-motion")).toHaveTextContent("true");
  });
});

describe("useTransitionState", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns current transition state from context", () => {
    render(
      <ViewTransitionProvider>
        <TransitionStateConsumer />
      </ViewTransitionProvider>
    );

    expect(screen.getByTestId("hook-state")).toHaveTextContent("idle");
  });

  test("returns default state when used outside provider", () => {
    render(<TransitionStateConsumer />);

    // Should return default 'idle' state from default context value
    expect(screen.getByTestId("hook-state")).toHaveTextContent("idle");
  });

  test("reflects state changes from provider", async () => {
    function CombinedTest() {
      const { setTransitionState } = useContext(ViewTransitionContext);
      const state = useTransitionState();
      return (
        <div>
          <span data-testid="combined-state">{state}</span>
          <button onClick={() => setTransitionState("transitioning")}>Transition</button>
        </div>
      );
    }

    render(
      <ViewTransitionProvider>
        <CombinedTest />
      </ViewTransitionProvider>
    );

    expect(screen.getByTestId("combined-state")).toHaveTextContent("idle");

    await act(async () => {
      screen.getByText("Transition").click();
    });

    expect(screen.getByTestId("combined-state")).toHaveTextContent("transitioning");
  });
});
