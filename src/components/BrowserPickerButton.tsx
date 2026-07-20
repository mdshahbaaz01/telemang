import { Copy, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { copyWithToast } from "@/lib/clipboard";
import { toast } from "sonner";

type BrowserOption = { id: string; label: string; build: (url: string) => string };

const strip = (u: string) => u.replace(/^https?:\/\//i, "");

export const BROWSER_OPTIONS: BrowserOption[] = [
  { id: "telegram", label: "Telegram app", build: (u) => `tg://resolve?url=${encodeURIComponent(u)}` },
  {
    id: "android",
    label: "📱 System chooser (Just once / Always)",
    build: (u) => `intent://${strip(u)}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`,
  },
  { id: "chrome", label: "Chrome", build: (u) => `googlechrome://navigate?url=${encodeURIComponent(u)}` },
  { id: "firefox", label: "Firefox", build: (u) => `firefox://open-url?url=${encodeURIComponent(u)}` },
  { id: "brave", label: "Brave", build: (u) => `brave://open-url?url=${encodeURIComponent(u)}` },
  { id: "edge", label: "Microsoft Edge", build: (u) => `microsoft-edge:${u}` },
  { id: "opera", label: "Opera", build: (u) => `touch-http://${strip(u)}` },
  { id: "duckduckgo", label: "DuckDuckGo", build: (u) => `ddgQuickLink://${strip(u)}` },
  { id: "default", label: "Default browser", build: (u) => u },
];

export function openInBrowser(url: string, opt: BrowserOption) {
  const target = opt.build(url);
  // Intent URLs must navigate the top window — window.open('intent://…') is
  // blocked/ignored on most Android browsers, which is why the chooser never
  // appeared. Same-tab navigation reliably triggers the OS "Open with" sheet
  // (with Just once / Always buttons) when no default browser is set.
  if (target.startsWith("intent://") || target.startsWith("intent:")) {
    window.location.href = target;
    return;
  }
  try {
    const w = window.open(target, "_blank", "noopener,noreferrer");
    if (!w) window.location.href = target;
  } catch {
    window.location.href = target;
  }
}

export function BrowserPickerButton({
  url,
  size = "sm",
  variant = "outline",
  compact = false,
}: {
  url: string;
  size?: "sm" | "default" | "icon";
  variant?: "outline" | "ghost" | "default";
  compact?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={variant}
          size={compact ? "icon" : size}
          className={compact ? "h-6 w-6 shrink-0" : undefined}
          title="Open in specific browser (optional)"
        >
          <Globe className={compact ? "h-3 w-3" : "mr-1 h-4 w-4"} />
          {!compact && "Browser…"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="z-[60] w-56 p-1">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Open in browser
        </div>
        {BROWSER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
            onClick={() => openInBrowser(url, opt)}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
          onClick={() => copyWithToast(url, toast, "Link copied")}
        >
          <Copy className="h-3.5 w-3.5" /> Copy link
        </button>
        <div className="px-2 py-1 text-[10px] text-muted-foreground">
          Tip: "System chooser" tabhi popup dikhayega (Just once / Always)
          jab aapne koi default browser set nahi kiya ho. Agar already default
          set hai → Android Settings → Apps → Default apps → Browser app →
          "Clear defaults", phir dubara try karo.
        </div>
      </PopoverContent>
    </Popover>
  );
}