import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTelegramWebviewBridge } from "@/lib/telegram-webview-bridge";

export type MiniAppRequest = {
  accountId: string;
  peerKey: string;
  botKey?: string;
  url?: string;
  buttonText?: string;
  simple?: boolean;
  title?: string;
};

export function MiniAppDrawer({
  open,
  onClose,
  request,
  resolver,
}: {
  open: boolean;
  onClose: () => void;
  request: MiniAppRequest | null;
  resolver: (r: MiniAppRequest) => Promise<{ url: string; queryId: string | null }>;
}) {
  const [loading, setLoading] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useTelegramWebviewBridge(iframeRef);

  useEffect(() => {
    if (!open || !request) {
      setResolvedUrl(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    resolver(request)
      .then((res) => {
        if (cancelled) return;
        if (!res.url) setError("Telegram returned no mini app URL.");
        else setResolvedUrl(res.url);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message || "Failed to open mini app");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, request, resolver]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-hidden bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {request?.title || request?.buttonText || "Telegram Mini App"}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {resolvedUrl ? new URL(resolvedUrl).host : "resolving…"}
            </div>
          </div>
          {resolvedUrl && (
            <a
              href={resolvedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded p-1 hover:bg-muted"
              title="Open in new tab"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          Best-effort preview. Some Telegram features (haptics, MainButton, payments) only
          work inside the native Telegram client.
        </div>

        <div className="relative flex-1">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && (
            <div className="p-4 text-sm text-destructive">
              <div className="mb-2 font-semibold">Couldn't open mini app</div>
              <p className="text-xs">{error}</p>
            </div>
          )}
          {resolvedUrl && !error && (
            <iframe
              key={resolvedUrl}
              ref={iframeRef}
              src={resolvedUrl}
              title={request?.buttonText || "Telegram Mini App"}
              className="h-full w-full border-0"
              allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-storage-access-by-user-activation"
              referrerPolicy="no-referrer"
              onError={() =>
                setError(
                  "The mini app refused to load (X-Frame-Options / CSP). Use 'Open in new tab' above.",
                )
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}