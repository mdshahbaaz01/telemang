import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";
type Accent = "slate" | "emerald" | "rose" | "amber";

const ACCENTS: Record<Accent, { primary: string; primaryForeground: string }> = {
  slate: { primary: "oklch(0.208 0.042 265.755)", primaryForeground: "oklch(0.984 0.003 247.858)" },
  emerald: { primary: "oklch(0.56 0.145 156)", primaryForeground: "oklch(0.985 0.01 156)" },
  rose: { primary: "oklch(0.58 0.22 22)", primaryForeground: "oklch(0.985 0.01 22)" },
  amber: { primary: "oklch(0.69 0.16 76)", primaryForeground: "oklch(0.16 0.03 76)" },
};

const ThemeContext = createContext<{
  theme: Theme;
  accent: Accent;
  setTheme: (theme: Theme) => void;
  setAccent: (accent: Accent) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [accent, setAccentState] = useState<Accent>("slate");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("tm-theme") as Theme | null;
    const savedAccent = window.localStorage.getItem("tm-accent") as Accent | null;
    if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") setThemeState(savedTheme);
    if (savedAccent && savedAccent in ACCENTS) setAccentState(savedAccent);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
      const selected = ACCENTS[accent];
      root.style.setProperty("--primary", selected.primary);
      root.style.setProperty("--primary-foreground", selected.primaryForeground);
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, accent]);

  const value = useMemo(() => ({
    theme,
    accent,
    setTheme: (next: Theme) => {
      setThemeState(next);
      window.localStorage.setItem("tm-theme", next);
    },
    setAccent: (next: Accent) => {
      setAccentState(next);
      window.localStorage.setItem("tm-accent", next);
    },
  }), [theme, accent]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}

export const themeAccents = ACCENTS;