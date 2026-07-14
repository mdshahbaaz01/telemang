import { toast } from "sonner";
import { Copy, ExternalLink, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyWithToast } from "@/lib/clipboard";
import { chatViewer } from "@/components/chat/chat-viewer-store";

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
        </div>
      </div>
    </div>
  );
}