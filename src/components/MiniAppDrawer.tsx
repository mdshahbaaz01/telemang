import { useEffect, useMemo, useRef, useState } from "react";
import { X, Loader2, RefreshCw, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrowserPickerButton } from "@/components/BrowserPickerButton";
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
  const [blocked, setBlocked] = useState<{ text?: string } | null>(null);
  const [directMode, setDirectMode] = useState(false);
  const [slowFallback, setSlowFallback] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useTelegramWebviewBridge(iframeRef, { onBlocked: (details) => setBlocked({ text: details.text }) });
  const solve = useServerFn(solveCaptcha);

  type CapLog = { ts: number; level: "info" | "warn" | "error"; source: "iframe" | "host"; msg: string; extra?: any };
  const [capLogs, setCapLogs] = useState<CapLog[]>([]);
  const [capOpen, setCapOpen] = useState(false);
  const pushLog = (l: Omit<CapLog, "ts"> & { ts?: number }) =>
    setCapLogs((prev) => {
      const next = [...prev, { ts: l.ts ?? Date.now(), level: l.level, source: l.source, msg: l.msg, extra: l.extra }];
      return next.length > 200 ? next.slice(-200) : next;
    });

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
      if (!data) return;
      if (data.eventType === "captcha_log") {
        const d = data.eventData || {};
        pushLog({ level: d.level || "info", source: "iframe", msg: d.msg || "(no message)", extra: d.extra, ts: d.ts });
        return;
      }
      if (data.eventType !== "captcha_detected") return;
      const items = Array.isArray(data.eventData?.items) ? data.eventData.items : [];
      pushLog({ level: "info", source: "host", msg: `received captcha_detected (${items.length} item(s))`, extra: items });
      for (const it of items) {
        const key = `${it.type}|${it.sitekey}`;
        if (seen.has(key)) { pushLog({ level: "info", source: "host", msg: "skip duplicate", extra: { key } }); continue; }
        seen.add(key);
        pushLog({ level: "info", source: "host", msg: `calling solveCaptcha`, extra: { kind: it.type, sitekey: it.sitekey } });
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
          const method = (res as any)?.method ?? (res as any)?.provider ?? "unknown";
          if (token && iframe.contentWindow) {
            pushLog({ level: "info", source: "host", msg: "solver returned token, posting to iframe", extra: { kind: it.type, tokenLen: String(token).length, method } });
            iframe.contentWindow.postMessage(
              JSON.stringify({ __lovableCaptchaSolved: true, kind: it.type, token }),
              "*",
            );
          } else {
            pushLog({ level: "warn", source: "host", msg: "solver returned no token", extra: { kind: it.type, method, res } });
          }
        } catch (e) {
          pushLog({ level: "error", source: "host", msg: "solver threw", extra: { kind: it.type, err: (e as Error)?.message || String(e) } });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [solve, request?.accountId]);

  const { url: proxiedUrl } = useMiniAppProxyUrl(resolvedUrl, request?.accountId ?? "anon", { captcha: true });
  const iframeUrl = directMode ? resolvedUrl : proxiedUrl;

  useEffect(() => {
    if (!open || !request) {
      setResolvedUrl(null);
      setError(null);
      setReloadNonce(0);
        setDirectMode(false);
        setSlowFallback(false);
      setCapLogs([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlocked(null);
    setDirectMode(false);
    setSlowFallback(false);
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

  useEffect(() => {
    if (!iframeUrl || error) return;
    setSlowFallback(false);
    const t = window.setTimeout(() => setSlowFallback(true), directMode ? 6500 : 8500);
    return () => window.clearTimeout(t);
  }, [iframeUrl, reloadNonce, directMode, error]);

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
              variant={directMode ? "secondary" : "outline"}
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => { setDirectMode((v) => !v); setBlocked(null); setReloadNonce((n) => n + 1); }}
              title="Load from your device instead of the server proxy"
            >
              {directMode ? "Direct" : "Proxy"}
            </Button>
          )}
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
            <>
              <iframe
                key={`${iframeUrl}:${reloadNonce}`}
                ref={iframeRef}
                src={iframeUrl}
                title={request?.buttonText || "Telegram Mini App"}
                name={`tgminiapp-${request?.accountId ?? "drawer"}`}
                className="h-full w-full border-0"
                allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
                referrerPolicy="no-referrer-when-downgrade"
                onLoad={() => setSlowFallback(false)}
                onError={() =>
                  setError(
                    "The mini app refused to load in the embedded viewer.",
                  )
                }
              />
              {slowFallback && resolvedUrl && !blocked && (
                <div className="absolute inset-x-3 bottom-3 rounded-lg border border-yellow-500/40 bg-background/95 p-3 text-xs shadow-lg backdrop-blur">
                  <div className="mb-2 font-semibold">Mini app is not responding here</div>
                  <div className="mb-3 text-muted-foreground">
                    If direct mode shows “Connection Lost” and proxy mode says “refused to connect”, open it in Telegram/System Browser.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!directMode && (
                      <Button size="sm" variant="secondary" onClick={() => { setDirectMode(true); setReloadNonce((n) => n + 1); }}>
                        Try direct
                      </Button>
                    )}
                    <BrowserPickerButton url={resolvedUrl} size="sm" variant="outline" />
                  </div>
                </div>
              )}
              {blocked && resolvedUrl && (
                <div className="absolute inset-x-3 bottom-3 rounded-lg border border-border bg-background/95 p-3 text-xs shadow-lg backdrop-blur">
                  <div className="mb-2 font-semibold">Verification blocked in embedded view</div>
                  <div className="mb-3 line-clamp-2 text-muted-foreground">{blocked.text || "The verification site rejected the proxy session."}</div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => { setBlocked(null); setReloadNonce((n) => n + 1); }}>
                      <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry
                    </Button>
                    {!directMode && (
                      <Button size="sm" variant="outline" onClick={() => { setDirectMode(true); setBlocked(null); setReloadNonce((n) => n + 1); }}>
                        Direct device mode
                      </Button>
                    )}
                    <BrowserPickerButton url={resolvedUrl} size="sm" variant="outline" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t bg-muted/30 text-xs">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-muted/60"
            onClick={() => setCapOpen((v) => !v)}
          >
            <span className="font-medium">
              Captcha log
              <span className="ml-2 text-muted-foreground">
                ({capLogs.length}
                {capLogs.some((l) => l.level === "error") ? " · errors" : ""}
                {capLogs.some((l) => l.level === "warn") ? " · warnings" : ""})
              </span>
            </span>
            <span className="flex items-center gap-1">
              {capLogs.length > 0 && capOpen && (
                <Trash2
                  className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setCapLogs([]); }}
                />
              )}
              {capOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </span>
          </button>
          {capOpen && (
            <div className="max-h-56 overflow-auto border-t bg-background px-2 py-1 font-mono text-[10px] leading-tight">
              {capLogs.length === 0 ? (
                <div className="p-2 text-muted-foreground">
                  No captcha events yet. Events appear here as widgets are detected, reset, or solved.
                </div>
              ) : (
                capLogs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      "border-b border-border/40 py-1 " +
                      (l.level === "error"
                        ? "text-destructive"
                        : l.level === "warn"
                        ? "text-amber-500"
                        : "text-foreground")
                    }
                  >
                    <div>
                      <span className="text-muted-foreground">
                        {new Date(l.ts).toLocaleTimeString()} [{l.source}/{l.level}]
                      </span>{" "}
                      {l.msg}
                    </div>
                    {l.extra != null && (
                      <div className="whitespace-pre-wrap break-all pl-4 text-muted-foreground">
                        {(() => { try { return JSON.stringify(l.extra); } catch { return String(l.extra); } })()}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}