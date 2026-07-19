import { toast } from "sonner";
import { Copy, ExternalLink, MessageCircle, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyWithToast } from "@/lib/clipboard";
import { chatViewer } from "@/components/chat/chat-viewer-store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type BrowserOption = { id: string; label: string; build: (url: string) => string };

function stripScheme(u: string): string {
  return u.replace(/^https?:\/\//i, "");
}

const BROWSER_OPTIONS: BrowserOption[] = [
  {
    id: "android-chooser",
    label: "Android: pick browser…",
    build: (u) => {
      const noScheme = stripScheme(u);
      return `intent://${noScheme}#Intent;scheme=https;action=android.intent.action.VIEW;end`;
    },
  },
  { id: "chrome", label: "Chrome", build: (u) => `googlechrome://navigate?url=${encodeURIComponent(u)}` },
  { id: "firefox", label: "Firefox", build: (u) => `firefox://open-url?url=${encodeURIComponent(u)}` },
  { id: "brave", label: "Brave", build: (u) => `brave://open-url?url=${encodeURIComponent(u)}` },
  { id: "edge", label: "Microsoft Edge", build: (u) => `microsoft-edge:${u}` },
  { id: "opera", label: "Opera", build: (u) => `touch-http://${stripScheme(u)}` },
  { id: "duckduckgo", label: "DuckDuckGo", build: (u) => `ddgQuickLink://${stripScheme(u)}` },
  { id: "default", label: "Default browser", build: (u) => u },
];

function isTelegramLink(u: string): boolean {
  return /^(https?:\/\/)?(t\.me|telegram\.me|telegram\.dog)\//i.test(u.trim()) || /^tg:\/\//i.test(u.trim());
}

function toViewerTarget(u: string): string {
  const s = u.trim();
  // tg://resolve?domain=foo → foo ; tg://join?invite=hash → +hash
  const tgMatch = s.match(/^tg:\/\/(resolve|join)\?(.*)$/i);
  if (tgMatch) {
    const params = new URLSearchParams(tgMatch[2]);
    if (params.get("domain")) return params.get("domain")!;
    if (params.get("invite")) return `+${params.get("invite")}`;
  }
  return s;
}

export function ConfirmUrlDialog({ url, onClose, accountId }: { url: string; onClose: () => void; accountId?: string | null }) {
  const isTg = isTelegramLink(url);
  const openInBrowser = (opt: BrowserOption) => {
    const target = opt.build(url);
    try {
      window.open(target, "_blank", "noopener,noreferrer");
    } catch {
      window.location.href = target;
    }
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-semibold">{isTg ? "Open Telegram link?" : "Open external link?"}</div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            title="Copy link"
            onClick={() => copyWithToast(url, toast)}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mb-3 break-all rounded-md border bg-muted p-2 text-xs">{url}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={() => copyWithToast(url, toast)}>
            <Copy className="mr-1 h-4 w-4" /> Copy
          </Button>
          {isTg && (
            <Button
              size="sm"
              onClick={() => {
                chatViewer.open(toViewerTarget(url), accountId ?? null);
                onClose();
              }}
            >
              <MessageCircle className="mr-1 h-4 w-4" /> Open here
            </Button>
          )}
          <Button
            variant={isTg ? "outline" : "default"}
            size="sm"
            onClick={() => {
              window.open(url, "_blank", "noopener,noreferrer");
              onClose();
            }}
          >
            <ExternalLink className="mr-1 h-4 w-4" /> {isTg ? "External" : "Open"}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" title="Open in specific browser (optional)">
                <Globe className="mr-1 h-4 w-4" /> Browser…
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Open in browser
              </div>
              {BROWSER_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                  onClick={() => openInBrowser(opt)}
                >
                  {opt.label}
                </button>
              ))}
              <div className="px-2 py-1 text-[10px] text-muted-foreground">
                Agar browser installed nahi hai to link silently fail ho sakta hai.
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}