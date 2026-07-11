// Client helper to route a mini-app URL through the fingerprinting proxy.
export function proxifyMiniAppUrl(url: string, accountId: string): string {
  try {
    if (!/^https?:\/\//i.test(url)) return url;
    // Split the fragment: browsers never send #... to the server, so we
    // must preserve it on the client-facing proxy URL. Telegram Mini Apps
    // deliver the signed initData via #tgWebAppData=..., losing it makes
    // the app fall back to a normal (unauthenticated) login page.
    const hashIdx = url.indexOf("#");
    const bare = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const hash = hashIdx === -1 ? "" : url.slice(hashIdx);
    return `/api/public/miniapp-proxy/${encodeURIComponent(bare)}?a=${encodeURIComponent(accountId)}${hash}`;
  } catch {
    return url;
  }
}