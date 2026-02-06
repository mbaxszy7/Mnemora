/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useLanguage } from "./use-language";
import { LANGUAGE_STORAGE_KEY } from "@shared/i18n-types";

const mockI18n = vi.hoisted(() => ({
  language: "en",
  changeLanguage: vi.fn(async (lang: string) => {
    mockI18n.language = lang;
  }),
}));

const mockUseTranslation = vi.hoisted(() => vi.fn(() => ({ i18n: mockI18n })));
const mockI18nApi = vi.hoisted(() => ({
  getLanguage: vi.fn(async () => "en"),
  changeLanguage: vi.fn(async () => {}),
}));

vi.mock("react-i18next", () => ({
  useTranslation: mockUseTranslation,
}));

describe("useLanguage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockI18n.language = "en";
    localStorage.clear();
    (window as unknown as { i18nApi: typeof mockI18nApi }).i18nApi = mockI18nApi;
  });

  it("returns current language and constants", () => {
    mockI18n.language = "zh-CN";

    const { result } = renderHook(() => useLanguage());

    expect(result.current.currentLanguage).toBe("zh-CN");
    expect(result.current.supportedLanguages).toContain("en");
    expect(result.current.supportedLanguages).toContain("zh-CN");
  });

  it("changes language and persists to localStorage", async () => {
    const { result } = renderHook(() => useLanguage());

    await act(async () => {
      await result.current.changeLanguage("zh-CN");
    });

    expect(mockI18n.changeLanguage).toHaveBeenCalledWith("zh-CN");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
    expect(mockI18nApi.changeLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("does not change language when target is current language", async () => {
    mockI18n.language = "en";
    const { result } = renderHook(() => useLanguage());

    await act(async () => {
      await result.current.changeLanguage("en");
    });

    expect(mockI18n.changeLanguage).not.toHaveBeenCalled();
    expect(mockI18nApi.changeLanguage).not.toHaveBeenCalled();
  });

  it("prefers local stored language and syncs it to main process", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    mockI18n.language = "en";

    renderHook(() => useLanguage());

    await waitFor(() => {
      expect(mockI18n.changeLanguage).toHaveBeenCalledWith("zh-CN");
    });
    expect(mockI18nApi.changeLanguage).toHaveBeenCalledWith("zh-CN");
    expect(mockI18nApi.getLanguage).not.toHaveBeenCalled();
  });

  it("pulls language from main process when local storage is empty", async () => {
    mockI18n.language = "en";
    mockI18nApi.getLanguage.mockResolvedValueOnce("zh-CN");

    renderHook(() => useLanguage());

    await waitFor(() => {
      expect(mockI18nApi.getLanguage).toHaveBeenCalled();
    });
    expect(mockI18n.changeLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("swallows sync errors without breaking hook state", async () => {
    mockI18nApi.getLanguage.mockRejectedValueOnce(new Error("not available"));

    const { result } = renderHook(() => useLanguage());

    await waitFor(() => {
      expect(mockI18nApi.getLanguage).toHaveBeenCalled();
    });
    expect(result.current.currentLanguage).toBe("en");
  });
});
