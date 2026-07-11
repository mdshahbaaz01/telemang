// Client helper to route a mini-app URL through the fingerprinting proxy.
export function proxifyMiniAppUrl(url: string, accountId: string): string {
  try {
    // Only proxy http(s) targets; leave data:/blob:/about: untouched.
    if (!/^https?:\/\//i.test(url)) return url;
    return `/api/public/miniapp-proxy/${encodeURIComponent(url)}?a=${encodeURIComponent(accountId)}`;
  } catch {
    return url;
  }
}