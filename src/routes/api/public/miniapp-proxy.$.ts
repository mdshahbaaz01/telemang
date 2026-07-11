import { createFileRoute } from "@tanstack/react-router";
import { deriveMiniAppIdentity } from "@/lib/mini-app-identity.server";

// Cross-origin mini-app proxy that:
//   1. strips X-Frame-Options / CSP so the app renders in an iframe;
//   2. rewrites the origin so relative URLs continue to load via us;
//   3. injects a per-account fingerprint override (navigator, screen,
//      timezone, canvas noise) so each account looks like a distinct
//      device to bot verification systems that read Web APIs.
//
// Usage: /api/public/miniapp-proxy/<encoded-target>?a=<accountId>
// The <encoded-target> is the full upstream URL, encodeURIComponent-ed.

const STRIP_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

function buildOverrideScript(accountId: string) {
  const fp = deriveMiniAppIdentity(accountId).fingerprint;
  return `(() => {
  try {
    const fp = ${JSON.stringify(fp)};
    const nav = Object.getPrototypeOf(navigator);
    const set = (obj, key, val) => {
      try { Object.defineProperty(obj, key, { get: () => val, configurable: true }); } catch (e) {}
    };
    set(nav, 'userAgent', fp.userAgent);
    set(nav, 'appVersion', fp.userAgent.replace(/^Mozilla\\//, ''));
    set(nav, 'platform', fp.platform);
    set(nav, 'language', fp.languages[0]);
    set(nav, 'languages', Object.freeze(fp.languages.slice()));
    set(nav, 'hardwareConcurrency', fp.hardwareConcurrency);
    set(nav, 'deviceMemory', fp.deviceMemory);
    set(nav, 'maxTouchPoints', fp.mobile ? 5 : 0);
    set(nav, 'vendor', fp.platform === 'iPhone' || fp.platform === 'MacIntel' ? 'Apple Computer, Inc.' : 'Google Inc.');
    if (navigator.userAgentData) {
      const brands = [
        { brand: 'Chromium', version: '118' },
        { brand: 'Not-A.Brand', version: '99' },
      ];
      set(navigator.userAgentData, 'mobile', fp.mobile);
      set(navigator.userAgentData, 'platform', fp.platform.includes('iPhone') ? 'iOS' : fp.platform.includes('Mac') ? 'macOS' : fp.platform.includes('Win') ? 'Windows' : fp.mobile ? 'Android' : 'Linux');
      set(navigator.userAgentData, 'brands', brands);
    }
    const scr = Object.getPrototypeOf(screen);
    set(scr, 'width', fp.screenW);
    set(scr, 'height', fp.screenH);
    set(scr, 'availWidth', fp.screenW);
    set(scr, 'availHeight', fp.screenH);
    set(scr, 'colorDepth', 24);
    set(scr, 'pixelDepth', 24);
    try { Object.defineProperty(window, 'devicePixelRatio', { get: () => fp.dpr, configurable: true }); } catch (e) {}
    // Timezone
    try {
      const OrigDTF = Intl.DateTimeFormat;
      function PatchedDTF() {
        const args = Array.from(arguments);
        if (args[1] && typeof args[1] === 'object' && !args[1].timeZone) args[1].timeZone = fp.timezone;
        else if (!args[1]) args[1] = { timeZone: fp.timezone };
        const inst = new OrigDTF(args[0], args[1]);
        const origResolved = inst.resolvedOptions.bind(inst);
        inst.resolvedOptions = function() { const r = origResolved(); r.timeZone = fp.timezone; return r; };
        return inst;
      }
      PatchedDTF.prototype = OrigDTF.prototype;
      PatchedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf;
      Intl.DateTimeFormat = PatchedDTF;
    } catch (e) {}
    // Canvas noise (deterministic per account)
    try {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      const seed = fp.canvasSeed;
      const jitter = (data) => {
        for (let i = 0; i < data.length; i += 4) {
          const n = ((i * seed * 9301) | 0) % 3;
          data[i] = (data[i] + n) & 0xff;
        }
      };
      CanvasRenderingContext2D.prototype.getImageData = function() {
        const img = origGetImageData.apply(this, arguments);
        jitter(img.data);
        return img;
      };
      HTMLCanvasElement.prototype.toDataURL = function() {
        try {
          const ctx = this.getContext('2d');
          if (ctx) {
            const img = origGetImageData.call(ctx, 0, 0, this.width, this.height);
            jitter(img.data);
            ctx.putImageData(img, 0, 0);
          }
        } catch (e) {}
        return origToDataURL.apply(this, arguments);
      };
    } catch (e) {}
    // Stable unique storage namespace
    try { window.name = 'acct-' + fp.hashKey; } catch (e) {}
  } catch (err) { console.warn('[fingerprint override failed]', err); }
})();`;
}

async function handle(request: Request, params: { _splat?: string }) {
  const target = params._splat ? decodeURIComponent(params._splat) : "";
  if (!target || !/^https?:\/\//.test(target)) {
    return new Response("Missing target URL", { status: 400 });
  }
  const proxyReqUrl = new URL(request.url);
  const accountId = proxyReqUrl.searchParams.get("a") || "anon";

  const upstreamHeaders = new Headers();
  const fp = deriveMiniAppIdentity(accountId).fingerprint;
  upstreamHeaders.set("user-agent", fp.userAgent);
  upstreamHeaders.set("accept-language", fp.languages.join(","));
  const accept = request.headers.get("accept");
  if (accept) upstreamHeaders.set("accept", accept);
  const referer = request.headers.get("referer");
  if (referer) upstreamHeaders.set("referer", target);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "follow",
    });
  } catch (e) {
    return new Response(`Upstream fetch failed: ${(e as Error).message}`, { status: 502 });
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!STRIP_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
  });
  outHeaders.set("access-control-allow-origin", "*");

  const ctype = upstream.headers.get("content-type") || "";
  if (ctype.includes("text/html")) {
    let html = await upstream.text();
    const upstreamOrigin = new URL(upstream.url || target).origin;
    const script = `<script>${buildOverrideScript(accountId)}</script>`;
    const base = `<base href="${upstreamOrigin}/">`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${base}${script}`);
    } else {
      html = `${base}${script}${html}`;
    }
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(html, { status: upstream.status, headers: outHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export const Route = createFileRoute("/api/public/miniapp-proxy/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => handle(request, params),
      POST: ({ request, params }) => handle(request, params),
    },
  },
});