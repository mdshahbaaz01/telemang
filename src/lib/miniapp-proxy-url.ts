// Client helper to route a mini-app URL through the fingerprinting proxy.
// A short-lived HMAC token (minted by an authenticated server function) is
// required; without it the proxy rejects the request. Use
// `useMiniAppProxyUrl` for the async, auth-bound flow.
export function proxifyMiniAppUrl(
  url: string,
  accountId: string,
  token: string,
): string {
  try {
    if (!/^https?:\/\//i.test(url)) return url;
    if (!token) return "";
    const hashIdx = url.indexOf("#");
    const bare = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const hash = hashIdx === -1 ? "" : url.slice(hashIdx);
    const base = proxyOriginForCurrentHost();
    return `${base}/api/public/miniapp-proxy/${encodeURIComponent(bare)}?a=${encodeURIComponent(
      accountId,
    )}&t=${encodeURIComponent(token)}${hash}`;
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