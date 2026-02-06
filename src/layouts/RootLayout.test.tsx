/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "@testing-library/jest-dom/vitest";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockUseNotification = vi.hoisted(() => vi.fn());
const mockOnNavigate = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/hooks/use-notification", () => ({
  useNotification: mockUseNotification,
}));

vi.mock("@/components/core/TitleBar", () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}));

import RootLayout from "./RootLayout";

describe("RootLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { appApi: { onNavigate: typeof mockOnNavigate } }).appApi = {
      onNavigate: mockOnNavigate,
    };
  });

  it("renders title bar and outlet content", () => {
    mockOnNavigate.mockReturnValue(() => {});

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RootLayout />}>
            <Route index element={<div data-testid="outlet-content">content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("title-bar")).toBeInTheDocument();
    expect(screen.getByTestId("outlet-content")).toBeInTheDocument();
    expect(mockUseNotification).toHaveBeenCalled();
  });

  it("subscribes navigation callback and cleans up on unmount", () => {
    const cleanup = vi.fn();
    mockOnNavigate.mockReturnValue(cleanup);

    const { unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RootLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(mockOnNavigate).toHaveBeenCalledWith(expect.any(Function));

    const handler = mockOnNavigate.mock.calls[0]?.[0] as (path: string) => void;
    handler("/settings/llm-config");
    expect(mockNavigate).toHaveBeenCalledWith("/settings/llm-config");

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
