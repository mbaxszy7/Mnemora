/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { IPC_CHANNELS } from "@shared/ipc-types";
import { useAiFuseToast } from "./use-ai-fuse-toast";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockOn = vi.hoisted(() => vi.fn());
const mockOff = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
  },
}));

describe("useAiFuseToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { ipcRenderer: unknown }).ipcRenderer = {
      on: mockOn,
      off: mockOff,
    };
  });

  it("subscribes and unsubscribes ipc event", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>{children}</MemoryRouter>
    );
    const { unmount } = renderHook(() => useAiFuseToast(), { wrapper });
    expect(mockOn).toHaveBeenCalledWith(IPC_CHANNELS.AI_FAILURE_FUSE_TRIPPED, expect.any(Function));
    unmount();
    expect(mockOff).toHaveBeenCalledWith(
      IPC_CHANNELS.AI_FAILURE_FUSE_TRIPPED,
      expect.any(Function)
    );
  });

  it("shows toast and action navigates to llm config", () => {
    let handler:
      | ((event: unknown, payload: { count: number; windowMs: number }) => void)
      | undefined;
    mockOn.mockImplementationOnce((_ch, cb) => {
      handler = cb;
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>{children}</MemoryRouter>
    );
    renderHook(() => useAiFuseToast(), { wrapper });

    handler?.({}, { count: 3, windowMs: 10000 });
    expect(mockToastError).toHaveBeenCalled();

    const options = mockToastError.mock.calls[0]?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    options?.action?.onClick?.();
    expect(mockNavigate).toHaveBeenCalledWith("/settings/llm-config");
  });
});
