import { useEffect, useMemo, useRef, useState } from "react";
import { X, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTelegramWebviewBridge } from "@/lib/telegram-webview-bridge";
import { useMiniAppProxyUrl } from "@/lib/miniapp-proxy-url";
import { useServerFn } from "@tanstack/react-start";
import { solveCaptcha } from "@/lib/captcha.functions";

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
  const [reloadNonce, setReloadNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useTelegramWebviewBridge(iframeRef);
  const solve = useServerFn(solveCaptcha);

  // Auto-solve captchas detected inside the mini-app iframe. The proxy
  // injects a bridge that posts { eventType: "captcha_detected", eventData:
  // { items: [{ type, sitekey, pageUrl }] } }. We forward each to the
  // solver and post the token back so the widget passes without user input.
  useEffect(() => {
    const seen = new Set<string>();
    const handler = async (ev: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || ev.source !== iframe.contentWindow) return;
      let data: any = ev.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
      if (!data || data.eventType !== "captcha_detected") return;
      const items = Array.isArray(data.eventData?.items) ? data.eventData.items : [];
      for (const it of items) {
        const key = `${it.type}|${it.sitekey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const res = await solve({
            data: {
              kind: it.type,
              sitekey: it.sitekey,
              pageUrl: it.pageUrl,
              accountId: request?.accountId,
            } as any,
          });
          const token = (res as any)?.answer;
          if (token && iframe.contentWindow) {
            iframe.contentWindow.postMessage(
              JSON.stringify({ __lovableCaptchaSolved: true, kind: it.type, token }),
              "*",
            );
          }
        } catch {
          // solver not configured or failed — silently continue; the
          // in-frame Turnstile watchdog will keep retrying the widget.
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [solve, request?.accountId]);

  const { url: iframeUrl } = useMiniAppProxyUrl(resolvedUrl, request?.accountId ?? "anon", { captcha: true });

  useEffect(() => {
    if (!open || !request) {
      setResolvedUrl(null);
      setError(null);
      setReloadNonce(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    resolver(request)
      .then((res) => {
        if (cancelled) return;
        if (!res.url) setError("Telegram returned no mini app URL.");
        else {
          setResolvedUrl(res.url);
          setReloadNonce((n) => n + 1);
        }
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => setReloadNonce((n) => n + 1)}
              title="Refresh mini app"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
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
          {iframeUrl && !error && (
            <iframe
              key={`${iframeUrl}:${reloadNonce}`}
              ref={iframeRef}
              src={iframeUrl}
              title={request?.buttonText || "Telegram Mini App"}
              name={`tgminiapp-${request?.accountId ?? "drawer"}`}
              className="h-full w-full border-0"
              allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-storage-access-by-user-activation"
              referrerPolicy="no-referrer"
              onError={() =>
                setError(
                  "The mini app refused to load in the embedded viewer.",
                )
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}