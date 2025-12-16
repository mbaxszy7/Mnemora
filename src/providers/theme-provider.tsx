import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "light" | "dark" | "system";
type EffectiveTheme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  effectiveTheme: EffectiveTheme;
  setTheme: (theme: Theme) => void;
};

/* eslint-disable react-refresh/only-export-components */
const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "mnemora_theme";
const prefersDarkMQ = "(prefers-color-scheme: dark)";

const readStoredTheme = (): Theme => {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
};

const getEffectiveTheme = (theme: Theme): EffectiveTheme => {
  if (theme === "system") {
    return window.matchMedia(prefersDarkMQ).matches ? "dark" : "light";
  }
  return theme;
};

const applyThemeClass = (effective: EffectiveTheme) => {
  const root = document.documentElement;
  if (effective === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  root.style.colorScheme = effective;
};

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() =>
    getEffectiveTheme(readStoredTheme())
  );

  // Apply theme when it changes
  useEffect(() => {
    const nextEffective = getEffectiveTheme(theme);
    setEffectiveTheme(nextEffective);
    applyThemeClass(nextEffective);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Listen to system changes when theme === system
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia(prefersDarkMQ);
    const handler = (event: MediaQueryListEvent) => {
      const nextEffective: EffectiveTheme = event.matches ? "dark" : "light";
      setEffectiveTheme(nextEffective);
      applyThemeClass(nextEffective);
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      effectiveTheme,
      setTheme: setThemeState,
    }),
    [theme, effectiveTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
