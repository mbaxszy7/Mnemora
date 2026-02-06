/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useContextSearch } from "./use-context-search";

const mockSearch = vi.fn();
const mockCancelSearch = vi.fn();

describe("useContextSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { contextGraphApi: unknown }).contextGraphApi = {
      search: mockSearch,
      cancelSearch: mockCancelSearch,
    };
    mockSearch.mockResolvedValue({
      success: true,
      data: { nodes: [], relatedEvents: [], evidence: [] },
    });
    mockCancelSearch.mockResolvedValue({ success: true, data: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates search and cancel to contextGraphApi", async () => {
    const { result } = renderHook(() => useContextSearch());

    await act(async () => {
      await result.current.search("hello");
      await result.current.cancel();
    });

    expect(mockSearch).toHaveBeenCalledWith("hello");
    expect(mockCancelSearch).toHaveBeenCalled();
  });

  it("best-effort cancels pending search on unmount", async () => {
    const { result, unmount } = renderHook(() => useContextSearch());

    await act(async () => {
      await result.current.search("pending");
    });
    unmount();

    expect(mockCancelSearch).toHaveBeenCalled();
  });
});
