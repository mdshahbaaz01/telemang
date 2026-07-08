import { useEffect, useState } from "react";
import { themeAccents, useTheme } from "@/components/theme-provider";

const labels = {
  slate: "Slate",
  emerald: "Emerald",
  rose: "Rose",
  amber: "Amber",
} as const;

export function ThemeCustomizer() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    if (theme === "dark") setIsDark(true);
    else if (theme === "light") setIsDark(false);
    else if (typeof window !== "undefined")
      setIsDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, [theme]);
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-background p-1 pl-2">
      <label className="theme-switch" aria-label="Toggle dark mode">
        <input
          type="checkbox"
          checked={isDark}
          onChange={(e) => setTheme(e.target.checked ? "dark" : "light")}
        />
        <div className="slider">
          <div className="sun-moon">
            <svg className="moon-dot moon-dot-1" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="moon-dot moon-dot-2" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="moon-dot moon-dot-3" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="light-ray light-ray-1" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="light-ray light-ray-2" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="light-ray light-ray-3" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="cloud-dark cloud-1" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="cloud-dark cloud-2" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="cloud-dark cloud-3" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="cloud-light cloud-4" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="cloud-light cloud-5" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
            <svg className="cloud-light cloud-6" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
          </div>
          <div className="stars">
            <svg className="star star-1" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" /></svg>
            <svg className="star star-2" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" /></svg>
            <svg className="star star-3" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" /></svg>
            <svg className="star star-4" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" /></svg>
          </div>
        </div>
      </label>
      <div className="h-5 w-px bg-border" />
      {(Object.keys(themeAccents) as Array<keyof typeof themeAccents>).map((key) => (
        <button
          key={key}
          type="button"
          aria-label={`${labels[key]} accent`}
          title={labels[key]}
          onClick={() => setAccent(key)}
          className={`h-6 w-6 rounded-full border ${accent === key ? "border-foreground" : "border-border"}`}
          style={{ background: themeAccents[key].primary }}
        />
      ))}
    </div>
  );
}