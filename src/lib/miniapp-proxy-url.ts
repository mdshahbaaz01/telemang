import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { mintMiniAppProxyToken } from "@/lib/miniapp-token.functions";

// Hook: mint (and auto-refresh) a proxy token and return the proxified URL.
// Returns null until the token is ready. Token TTL is 1h; we refresh 5m early.
export function useMiniAppProxyUrl(url: string | null | undefined, accountId: string, opts?: { captcha?: boolean }) {
  const mint = useServerFn(mintMiniAppProxyToken);
  const tokenQuery = useQuery({
    queryKey: ["miniapp-proxy-token"],
    queryFn: () => mint({ data: {} }),
    staleTime: 55 * 60 * 1000,
    refetchInterval: 55 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const token = tokenQuery.data?.token ?? "";
  const proxied = url && token ? proxifyMiniAppUrl(url, accountId, token, { captcha: opts?.captcha }) : null;
  return { url: proxied, loading: tokenQuery.isPending, error: tokenQuery.error };
}
// Client helper to route a mini-app URL through the fingerprinting proxy.
// A short-lived HMAC token (minted by an authenticated server function) is
// required; without it the proxy rejects the request. Use
// `useMiniAppProxyUrl` for the async, auth-bound flow.
export function proxifyMiniAppUrl(
  url: string,
  accountId: string,
  token: string,
  opts?: { captcha?: boolean },
): string {
  try {
    if (!/^https?:\/\//i.test(url)) return url;
    if (!token) return "";
    const hashIdx = url.indexOf("#");
    const bare = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const hash = hashIdx === -1 ? "" : url.slice(hashIdx);
    const base = proxyOriginForCurrentHost();
    const cap = opts?.captcha ? "&cap=1" : "";
    return `${base}/api/public/miniapp-proxy/${encodeURIComponent(bare)}?a=${encodeURIComponent(
      accountId,
    )}&t=${encodeURIComponent(token)}${cap}${hash}`;
  } catch {
    return "";
  }
}

// Preview hosts (id-preview--*.lovable.app and *.lovableproject.com) sit
// behind a Lovable auth wall that 302s /api/public/* to /auth-bridge, which
// makes the iframe render blank. The stable per-project dev URL
// (project--{id}-dev.lovable.app) serves the same build without the wall.
function proxyOriginForCurrentHost(): string {
  if (typeof window === "undefined") return "";
  const host = window.location.hostname;
  const id =
    host.match(/^id-preview--([0-9a-f-]+)\.lovable\.app$/i)?.[1] ??
    host.match(/^([0-9a-f-]+)\.lovableproject\.com$/i)?.[1] ??
    null;
  if (id) return `https://project--${id}-dev.lovable.app`;
  return ""; // same-origin on published / custom domains
}