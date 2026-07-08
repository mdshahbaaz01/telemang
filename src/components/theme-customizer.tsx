import { Moon, Palette, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { themeAccents, useTheme } from "@/components/theme-provider";

const labels = {
  slate: "Slate",
  emerald: "Emerald",
  rose: "Rose",
  amber: "Amber",
} as const;

export function ThemeCustomizer() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-background p-1">
      <Button type="button" variant={theme === "light" ? "secondary" : "ghost"} size="icon" onClick={() => setTheme("light")} aria-label="Light mode">
        <Sun className="h-4 w-4" />
      </Button>
      <Button type="button" variant={theme === "dark" ? "secondary" : "ghost"} size="icon" onClick={() => setTheme("dark")} aria-label="Dark mode">
        <Moon className="h-4 w-4" />
      </Button>
      <Button type="button" variant={theme === "system" ? "secondary" : "ghost"} size="icon" onClick={() => setTheme("system")} aria-label="System theme">
        <Palette className="h-4 w-4" />
      </Button>
      <div className="mx-1 h-5 w-px bg-border" />
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