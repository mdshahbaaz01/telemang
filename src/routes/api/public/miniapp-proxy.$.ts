import { createFileRoute } from "@tanstack/react-router";
import { deriveMiniAppIdentity } from "@/lib/mini-app-identity.server";
import { verifyMiniAppProxyToken, isBlockedProxyHost } from "@/lib/miniapp-token.server";

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
  "set-cookie",
]);

const COOKIE_JAR_NAME = "miniapp_proxy_cj";

const DROP_UPSTREAM_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cookie",
  "origin",
  "referer",
  "referrer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "upgrade-insecure-requests",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

type StoredCookie = {
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
  created: number;
};

type CookieJar = Record<string, Record<string, StoredCookie>>;

function b64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function readCookieValue(request: Request, cookieName: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === cookieName) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

function readCookieJar(request: Request): CookieJar {
  const raw = readCookieValue(request, COOKIE_JAR_NAME);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(b64urlDecode(raw)) as CookieJar;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function serializeCookieJar(jar: CookieJar): string {
  pruneExpiredCookies(jar);
  let encoded = b64urlEncode(JSON.stringify(jar));
  if (encoded.length <= 3600) return encoded;

  const all = Object.entries(jar).flatMap(([domain, cookies]) =>
    Object.entries(cookies).map(([name, cookie]) => ({ domain, name, created: cookie.created || 0 })),
  );
  all.sort((a, b) => a.created - b.created);
  for (const item of all) {
    delete jar[item.domain]?.[item.name];
    if (jar[item.domain] && Object.keys(jar[item.domain]).length === 0) delete jar[item.domain];
    encoded = b64urlEncode(JSON.stringify(jar));
    if (encoded.length <= 3600) return encoded;
  }
  return b64urlEncode("{}");
}

function defaultCookiePath(pathname: string): string {
  if (!pathname || !pathname.startsWith("/")) return "/";
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash + 1);
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,\s=]+=)/g).map((part) => part.trim()).filter(Boolean);
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof withGetter.getSetCookie === "function" ? withGetter.getSetCookie() : [];
  if (values.length) return values;
  const single = headers.get("set-cookie");
  return single ? splitSetCookieHeader(single) : [];
}

function parseSetCookie(raw: string, url: URL): { name: string; cookie: StoredCookie | null; domain: string } | null {
  const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1);
  let domain = url.hostname.toLowerCase();
  let path = defaultCookiePath(url.pathname);
  let expires: number | undefined;
  let secure = false;
  let deleteCookie = false;

  for (const attrRaw of parts) {
    const attrEq = attrRaw.indexOf("=");
    const key = (attrEq === -1 ? attrRaw : attrRaw.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? "" : attrRaw.slice(attrEq + 1).trim();
    if (key === "domain" && attrValue) domain = attrValue.replace(/^\./, "").toLowerCase();
    if (key === "path" && attrValue.startsWith("/")) path = attrValue;
    if (key === "secure") secure = true;
    if (key === "max-age") {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) {
        if (seconds <= 0) deleteCookie = true;
        else expires = Date.now() + seconds * 1000;
      }
    }
    if (key === "expires") {
      const ts = Date.parse(attrValue);
      if (Number.isFinite(ts)) {
        if (ts <= Date.now()) deleteCookie = true;
        else expires = ts;
      }
    }
  }

  if (deleteCookie) return { name, domain, cookie: null };
  return { name, domain, cookie: { value, domain, path, expires, secure, created: Date.now() } };
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const d = domain.replace(/^\./, "").toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  return pathname === cookiePath || pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function pruneExpiredCookies(jar: CookieJar) {
  const now = Date.now();
  for (const [domain, cookies] of Object.entries(jar)) {
    for (const [name, cookie] of Object.entries(cookies)) {
      if (cookie.expires && cookie.expires <= now) delete cookies[name];
    }
    if (Object.keys(cookies).length === 0) delete jar[domain];
  }
}

function mergeSetCookies(jar: CookieJar, url: URL, rawSetCookies: string[]) {
  if (!rawSetCookies.length) return;
  for (const raw of rawSetCookies) {
    const parsed = parseSetCookie(raw, url);
    if (!parsed) continue;
    jar[parsed.domain] = jar[parsed.domain] || {};
    if (parsed.cookie) jar[parsed.domain][parsed.name] = parsed.cookie;
    else delete jar[parsed.domain][parsed.name];
    if (Object.keys(jar[parsed.domain]).length === 0) delete jar[parsed.domain];
  }
}

function cookieHeaderForTarget(jar: CookieJar, url: URL): string {
  pruneExpiredCookies(jar);
  const pairs: string[] = [];
  for (const [domain, cookies] of Object.entries(jar)) {
    if (!domainMatches(url.hostname, domain)) continue;
    for (const [name, cookie] of Object.entries(cookies)) {
      if (cookie.secure && url.protocol !== "https:") continue;
      if (!pathMatches(url.pathname || "/", cookie.path || "/")) continue;
      pairs.push(`${name}=${cookie.value}`);
    }
  }
  return pairs.join("; ");
}

function toTelegramUserAgent(fp: ReturnType<typeof deriveMiniAppIdentity>["fingerprint"]) {
  const base = fp.userAgent;
  if (/Telegram-(Android|iOS)\//i.test(base)) return base;
  if (fp.platform.includes("iPhone")) {
    return `${base} Telegram-iOS/11.7`;
  }
  const androidVersion = /Android\s+([\d.]+)/i.exec(base)?.[1] || "14";
  const model = /;\s*([^;)]+)\)\s*AppleWebKit/i.exec(base)?.[1]?.trim() || "Pixel 7";
  const sdk = androidVersion.startsWith("12") ? "31" : androidVersion.startsWith("13") ? "33" : "34";
  return `${base} Telegram-Android/11.7.4 (${model}; Android ${androidVersion}; SDK ${sdk}; HIGH)`;
}

function setClientHintHeaders(headers: Headers, fp: ReturnType<typeof deriveMiniAppIdentity>["fingerprint"]) {
  const chromeVersion = (fp.userAgent.split("Chrome/")[1] || "").split(".")[0] || "120";
  const platform = fp.platform.includes("iPhone") ? "iOS" : fp.mobile ? "Android" : fp.platform.includes("Win") ? "Windows" : "Linux";
  headers.set("sec-ch-ua", `"Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}", "Not:A-Brand";v="99"`);
  headers.set("sec-ch-ua-mobile", fp.mobile ? "?1" : "?0");
  headers.set("sec-ch-ua-platform", `"${platform}"`);
}

function copyBrowserRequestHeaders(request: Request, upstreamHeaders: Headers) {
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (DROP_UPSTREAM_REQUEST_HEADERS.has(lower)) return;
    if (lower.startsWith("proxy-")) return;
    upstreamHeaders.set(key, value);
  });
}

function safeHeaderReferrer(raw: string | null, fallback: string): URL {
  try {
    const parsed = raw ? new URL(raw) : new URL(fallback);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !isBlockedProxyHost(parsed.hostname)) {
      return parsed;
    }
  } catch {}
  return new URL(fallback);
}

function buildOverrideScript(accountId: string, upstreamUrl: string, token: string, enableCaptcha: boolean, fpSeed: string) {
  const identityKey = fpSeed ? `${accountId}:${fpSeed}` : accountId;
  const identity = deriveMiniAppIdentity(identityKey);
  const fp = identity.fingerprint;
  const telegramUserAgent = toTelegramUserAgent(fp);
  const telegramDefaults = {
    platform: identity.platform,
    colorScheme: identity.colorScheme,
    themeParams: identity.themeParams,
    version: "8.0",
  };
  const captchaBridge = enableCaptcha ? `
  // ---------- Captcha auto-detect + solver bridge ----------
  try {
    const ORIGIN = location.origin;
    const CAPTCHA_STATE = { announced: {}, retries: {} };
    const seenKey = (o) => (o.type || '') + '|' + (o.sitekey || '');
    const capLog = (level, msg, extra) => {
      try { hostPost('captcha_log', { level: level || 'info', msg: String(msg), extra: extra || null, ts: Date.now() }); } catch {}
      try { console.log('[captcha]', level, msg, extra || ''); } catch {}
    };
    const detectAndAnnounce = () => {
      const found = [];
      document.querySelectorAll('[data-sitekey]').forEach((el) => {
        const sitekey = el.getAttribute('data-sitekey');
        if (!sitekey) return;
        const cls = String(el.className || '').toLowerCase();
        let type = 'recaptchaV2';
        if (cls.includes('h-captcha')) type = 'hcaptcha';
        else if (cls.includes('cf-turnstile')) type = 'turnstile';
        found.push({ type, sitekey, pageUrl: UPSTREAM });
      });
      // Only announce items we haven't already asked the host to solve.
      const fresh = found.filter((it) => !CAPTCHA_STATE.announced[seenKey(it)]);
      fresh.forEach((it) => { CAPTCHA_STATE.announced[seenKey(it)] = Date.now(); });
      if (fresh.length) {
        capLog('info', 'detected ' + fresh.length + ' new captcha widget(s)', { items: fresh, totalOnPage: found.length });
        hostPost('captcha_detected', { items: fresh });
      }
    };
    // ---- Turnstile watchdog: auto-reset the widget on failure ------------
    // Cloudflare frequently shows "Verification failed" for embedded/iframed
    // widgets on the first render. Reset the widget in-place; a legit
    // browser environment often passes on the 2nd or 3rd attempt.
    const turnstileReset = () => {
      try {
        if (window.turnstile && typeof window.turnstile.reset === 'function') {
          window.turnstile.reset();
          capLog('warn', 'turnstile.reset() invoked');
          return true;
        }
      } catch {}
      capLog('error', 'turnstile.reset() unavailable');
      return false;
    };
    const looksFailed = (el) => {
      try {
        const txt = (el.innerText || '').toLowerCase();
        return txt.includes('verification failed') || txt.includes('try again') || txt.includes('error');
      } catch { return false; }
    };
    const watchTurnstile = () => {
      document.querySelectorAll('.cf-turnstile,[data-sitekey]').forEach((el) => {
        const cls = String(el.className || '').toLowerCase();
        if (!cls.includes('cf-turnstile')) return;
        const key = 'ts:' + (el.getAttribute('data-sitekey') || '');
        const n = CAPTCHA_STATE.retries[key] || 0;
        if (looksFailed(el) && n < 4) {
          CAPTCHA_STATE.retries[key] = n + 1;
          capLog('warn', 'turnstile widget shows failure, scheduling reset', { attempt: n + 1, max: 4, sitekey: el.getAttribute('data-sitekey') });
          setTimeout(() => { turnstileReset(); }, 400 + n * 800);
        } else if (looksFailed(el)) {
          capLog('error', 'turnstile widget still failing after max resets', { attempts: n, sitekey: el.getAttribute('data-sitekey') });
        }
      });
    };
    setInterval(watchTurnstile, 2500);
    // Hook turnstile.render so we can capture the success callback and
    // inject the token when host-side auto-solver returns one.
    try {
      const install = () => {
        if (!window.turnstile || window.__lovableTurnstileHooked) return;
        window.__lovableTurnstileHooked = true;
        const orig = window.turnstile.render.bind(window.turnstile);
        capLog('info', 'turnstile.render hook installed');
        window.turnstile.render = function(container, params) {
          try {
            const cb = params && params.callback;
            const wrapped = Object.assign({}, params, {
              callback: (token) => {
                capLog('info', 'turnstile callback fired with token', { tokenLen: token ? String(token).length : 0 });
                try { cb && cb(token); } catch {}
                document.querySelectorAll('input[name="cf-turnstile-response"]').forEach((el) => { el.value = token; });
              },
              'error-callback': (err) => {
                capLog('error', 'turnstile error-callback', { err: String(err) });
                try { params && params['error-callback'] && params['error-callback'](err); } catch {}
              },
              'expired-callback': () => {
                capLog('warn', 'turnstile token expired');
                try { params && params['expired-callback'] && params['expired-callback'](); } catch {}
              },
            });
            const id = orig(container, wrapped);
            window.__lovableTurnstileWidgetId = id;
            window.__lovableTurnstileCallback = wrapped.callback;
            capLog('info', 'turnstile widget rendered', { widgetId: String(id), sitekey: params && params.sitekey });
            return id;
          } catch { return orig(container, params); }
        };
      };
      install();
      const hookInt = setInterval(install, 500);
      setTimeout(() => clearInterval(hookInt), 15000);
    } catch {}
    window.__lovableInjectCaptcha = (kind, token) => {
      try {
        const tokenLen = token ? String(token).length : 0;
        let injected = 0;
        if (kind === 'recaptchaV2' || kind === 'recaptchaV3') {
          document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response')
            .forEach((el) => { el.value = token; el.innerHTML = token; injected++; });
          if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
            Object.values(window.___grecaptcha_cfg.clients).forEach((client) => {
              const walk = (o) => { if (!o || typeof o !== 'object') return;
                for (const k of Object.keys(o)) {
                  const v = o[k]; if (v && typeof v === 'object' && typeof v.callback === 'function') {
                    try { v.callback(token); injected++; } catch {}
                  } else walk(v);
                }
              };
              walk(client);
            });
          }
        } else if (kind === 'hcaptcha') {
          document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]')
            .forEach((el) => { el.value = token; injected++; });
        } else if (kind === 'turnstile') {
          document.querySelectorAll('input[name="cf-turnstile-response"]')
            .forEach((el) => { el.value = token; injected++; });
          try {
            if (window.__lovableTurnstileCallback) { window.__lovableTurnstileCallback(token); injected++; }
          } catch {}
        }
        capLog(injected > 0 ? 'info' : 'warn', 'inject token result', { kind, tokenLen, injectedTargets: injected });
        return true;
      } catch (e) { capLog('error', 'inject token threw', { kind, err: String(e) }); return false; }
    };
    window.addEventListener('message', (ev) => {
      const d = typeof ev.data === 'string' ? (() => { try { return JSON.parse(ev.data); } catch { return null; } })() : ev.data;
      if (d && d.__lovableCaptchaSolved) {
        capLog('info', 'received solved token from host', { kind: d.kind, tokenLen: d.token ? String(d.token).length : 0 });
        window.__lovableInjectCaptcha(d.kind, d.token);
      }
    });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(detectAndAnnounce, 800));
    } else setTimeout(detectAndAnnounce, 800);
    let mo;
    try {
      mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(detectAndAnnounce, 1200); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
    capLog('info', 'captcha bridge armed', { upstream: UPSTREAM });
  } catch (err) { console.warn('[captcha bridge failed]', err); }
` : '';
  return `(() => {
  try {
    const fp = ${JSON.stringify(fp)};
    const ACCT = ${JSON.stringify(accountId)};
    const TOKEN = ${JSON.stringify(token)};
    const FP_SEED = ${JSON.stringify(fpSeed)};
    const CAP_ENABLED = ${enableCaptcha ? "true" : "false"};
    const UPSTREAM = ${JSON.stringify(upstreamUrl)};
    const TELEGRAM_UA = ${JSON.stringify(telegramUserAgent)};
    const TG_DEFAULTS = ${JSON.stringify(telegramDefaults)};
    const TG_PLATFORM = TG_DEFAULTS.platform || (String(fp.platform || '').includes('iPhone') ? 'ios' : 'android');
    const PROXY_PREFIX = '/api/public/miniapp-proxy/';
    const upstreamOrigin = (() => { try { return new URL(UPSTREAM).origin; } catch { return null; } })();
    try {
      const u = new URL(UPSTREAM);
      if (location.pathname.startsWith(PROXY_PREFIX)) {
        history.replaceState(history.state, '', location.origin + u.pathname + u.search + location.hash);
      }
    } catch {}
    const hostPost = (eventType, eventData) => {
      try {
        window.parent && window.parent.postMessage(JSON.stringify({ eventType, eventData: eventData || {} }), '*');
      } catch {}
    };
    const parseMaybeJson = (value) => {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    };
    const parseInitDataUnsafe = (initData) => {
      const out = {};
      try {
        const p = new URLSearchParams(initData || '');
        p.forEach((value, key) => { out[key] = parseMaybeJson(value); });
      } catch {}
      return out;
    };
    const toWebAppEvent = (eventType) => ({
      theme_changed: 'themeChanged',
      viewport_changed: 'viewportChanged',
      safe_area_changed: 'safeAreaChanged',
      content_safe_area_changed: 'contentSafeAreaChanged',
      main_button_pressed: 'mainButtonClicked',
      secondary_button_pressed: 'secondaryButtonClicked',
      back_button_pressed: 'backButtonClicked',
      settings_button_pressed: 'settingsButtonClicked',
      invoice_closed: 'invoiceClosed',
      popup_closed: 'popupClosed',
      qr_text_received: 'qrTextReceived',
      clipboard_text_received: 'clipboardTextReceived',
      write_access_requested: 'writeAccessRequested',
      contact_requested: 'contactRequested',
      phone_requested: 'phoneRequested',
      biometry_info_received: 'biometryInfoReceived',
      biometry_auth_requested: 'biometryAuthRequested',
      home_screen_checked: 'homeScreenChecked',
      home_screen_added: 'homeScreenAdded',
    })[eventType] || eventType;
    const installTelegramShim = () => {
      try {
        // Persist the signed tgWebApp* hash so later navigations under the
        // proxy (redirects to a bot's config page, etc.) still look like a
        // Telegram launch. Without this, sites downstream of the initial
        // hop see an empty location.hash and show "Telegram Required".
        const TG_STORE_KEY = '__lv_tgLaunchHash_v1__';
        const hashParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
        const searchParams = new URLSearchParams(String(location.search || '').replace(/^\?/, ''));
        // Some verification pages put tgWebAppData in the query string
        // beside botHash instead of in the URL hash. Telegram's official
        // web-app script only reads location.hash, so mirror every
        // tgWebApp* query parameter into the hash before page scripts run.
        try {
          searchParams.forEach((v, k) => {
            if (/^tgWebApp/i.test(k) && !hashParams.get(k)) hashParams.set(k, v);
          });
        } catch {}
        const hasSignedTg = Array.from(hashParams.keys()).some((k) => /^tgWebApp/i.test(k));
        try {
          if (hasSignedTg) {
            const mergedHash = hashParams.toString();
            sessionStorage.setItem(TG_STORE_KEY, mergedHash);
            if (mergedHash && String(location.hash || '').replace(/^#/, '') !== mergedHash) {
              try { history.replaceState(history.state, '', location.pathname + location.search + '#' + mergedHash); } catch {}
            }
          } else {
            const saved = sessionStorage.getItem(TG_STORE_KEY);
            if (saved) {
              const savedParams = new URLSearchParams(saved);
              savedParams.forEach((v, k) => { if (!hashParams.get(k)) hashParams.set(k, v); });
              try {
                const newHash = '#' + hashParams.toString();
                history.replaceState(history.state, '', location.pathname + location.search + newHash);
              } catch {}
            }
          }
        } catch {}
        try {
          if (!hashParams.get('tgWebAppVersion')) hashParams.set('tgWebAppVersion', TG_DEFAULTS.version || '8.0');
          if (!hashParams.get('tgWebAppPlatform')) hashParams.set('tgWebAppPlatform', TG_PLATFORM);
          if (!hashParams.get('tgWebAppThemeParams')) hashParams.set('tgWebAppThemeParams', JSON.stringify(TG_DEFAULTS.themeParams || {}));
          if (!hashParams.get('tgWebAppFullscreen')) hashParams.set('tgWebAppFullscreen', '1');
          if (!hashParams.get('tgWebAppShowSettings')) hashParams.set('tgWebAppShowSettings', '0');
          const mergedHashWithDefaults = hashParams.toString();
          if (mergedHashWithDefaults && String(location.hash || '').replace(/^#/, '') !== mergedHashWithDefaults) {
            try { history.replaceState(history.state, '', location.pathname + location.search + '#' + mergedHashWithDefaults); } catch {}
          }
        } catch {}
        const initData = hashParams.get('tgWebAppData') || '';
        const themeRaw = hashParams.get('tgWebAppThemeParams') || '';
        const parsedTheme = themeRaw ? parseMaybeJson(themeRaw) : null;
        const themeParams = parsedTheme && typeof parsedTheme === 'object' ? parsedTheme : (TG_DEFAULTS.themeParams || {});
        const callbacks = {};
        const emit = (eventType, eventData) => {
          const names = [eventType, toWebAppEvent(eventType)];
          names.forEach((name) => (callbacks[name] || []).slice().forEach((cb) => {
            try { cb(eventData || {}); } catch {}
          }));
        };
        window.addEventListener('message', (ev) => {
          let payload = ev.data;
          if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { return; }
          }
          if (!payload || typeof payload !== 'object' || !payload.eventType) return;
          emit(payload.eventType, payload.eventData || {});
        });
        const buttonApi = (name) => ({
          isVisible: false,
          isActive: true,
          isProgressVisible: false,
          text: '',
          color: themeParams.button_color || '#3390ec',
          textColor: themeParams.button_text_color || '#ffffff',
          show() { this.isVisible = true; hostPost('web_app_setup_' + name + '_button', this); return this; },
          hide() { this.isVisible = false; hostPost('web_app_setup_' + name + '_button', this); return this; },
          enable() { this.isActive = true; return this; },
          disable() { this.isActive = false; return this; },
          showProgress() { this.isProgressVisible = true; return this; },
          hideProgress() { this.isProgressVisible = false; return this; },
          setText(text) { this.text = String(text || ''); return this; },
          setParams(params) { Object.assign(this, params || {}); hostPost('web_app_setup_' + name + '_button', this); return this; },
          onClick(cb) { WebApp.onEvent(name === 'main' ? 'mainButtonClicked' : 'secondaryButtonClicked', cb); return this; },
          offClick(cb) { WebApp.offEvent(name === 'main' ? 'mainButtonClicked' : 'secondaryButtonClicked', cb); return this; },
        });
        const simpleButtonApi = (eventName, setupName) => ({
          isVisible: false,
          show() { this.isVisible = true; hostPost('web_app_setup_' + setupName + '_button', { is_visible: true }); return this; },
          hide() { this.isVisible = false; hostPost('web_app_setup_' + setupName + '_button', { is_visible: false }); return this; },
          onClick(cb) { WebApp.onEvent(eventName, cb); return this; },
          offClick(cb) { WebApp.offEvent(eventName, cb); return this; },
        });
        const WebApp = {
          initData,
          initDataUnsafe: parseInitDataUnsafe(initData),
          version: hashParams.get('tgWebAppVersion') || TG_DEFAULTS.version || '8.0',
          platform: hashParams.get('tgWebAppPlatform') || TG_PLATFORM,
          colorScheme: TG_DEFAULTS.colorScheme || (Object.keys(themeParams).length && String(themeParams.bg_color || '').toLowerCase() !== '#ffffff' ? 'dark' : 'light'),
          themeParams,
          isExpanded: true,
          isFullscreen: hashParams.get('tgWebAppFullscreen') === '1',
          isActive: true,
          viewportHeight: window.innerHeight,
          viewportStableHeight: window.innerHeight,
          safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
          contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
          headerColor: themeParams.header_bg_color || themeParams.bg_color || '#ffffff',
          backgroundColor: themeParams.bg_color || '#ffffff',
          bottomBarColor: themeParams.secondary_bg_color || themeParams.bg_color || '#ffffff',
          isClosingConfirmationEnabled: false,
          isVerticalSwipesEnabled: true,
          ready() { hostPost('web_app_ready', {}); },
          expand() { this.isExpanded = true; hostPost('web_app_expand', {}); },
          close() { hostPost('web_app_close', { reason: 'close' }); },
          sendData(data) { hostPost('web_app_data_send', { data: String(data || '') }); },
          openLink(url) { hostPost('web_app_open_link', { url: String(url || '') }); },
          openTelegramLink(url) { hostPost('web_app_open_tg_link', { url: String(url || '') }); },
          openInvoice(url) { hostPost('web_app_open_invoice', { slug: String(url || '') }); },
          showPopup(params, cb) { if (cb) setTimeout(() => cb('ok'), 0); return hostPost('web_app_open_popup', params || {}); },
          showAlert(message, cb) { if (cb) setTimeout(cb, 0); return hostPost('web_app_open_popup', { message: String(message || '') }); },
          showConfirm(message, cb) { if (cb) setTimeout(() => cb(true), 0); return hostPost('web_app_open_popup', { message: String(message || '') }); },
          onEvent(eventType, cb) {
            if (typeof cb !== 'function') return this;
            (callbacks[eventType] || (callbacks[eventType] = [])).push(cb);
            return this;
          },
          offEvent(eventType, cb) {
            callbacks[eventType] = (callbacks[eventType] || []).filter((x) => x !== cb);
            return this;
          },
          requestTheme() { hostPost('web_app_request_theme', {}); },
          requestViewport() { hostPost('web_app_request_viewport', {}); },
          requestWriteAccess(cb) { if (cb) setTimeout(() => cb(true), 0); hostPost('web_app_request_write_access', {}); },
          requestContact(cb) { if (cb) setTimeout(() => cb(false), 0); hostPost('web_app_request_phone', {}); },
          requestFullscreen() { this.isFullscreen = true; hostPost('web_app_request_fullscreen', {}); },
          exitFullscreen() { this.isFullscreen = false; hostPost('web_app_exit_fullscreen', {}); },
          lockOrientation() { hostPost('web_app_lock_orientation', {}); },
          unlockOrientation() { hostPost('web_app_unlock_orientation', {}); },
          addToHomeScreen() { hostPost('web_app_add_to_home_screen', {}); },
          checkHomeScreenStatus(cb) { if (cb) setTimeout(() => cb('unsupported'), 0); hostPost('web_app_check_home_screen', {}); },
          shareToStory(_mediaUrl, params) { hostPost('web_app_share_to_story', params || {}); },
          isVersionAtLeast(version) {
            const a = String(this.version || '0').split('.').map((x) => parseInt(x, 10) || 0);
            const b = String(version || '0').split('.').map((x) => parseInt(x, 10) || 0);
            for (let i = 0; i < Math.max(a.length, b.length); i++) {
              if ((a[i] || 0) > (b[i] || 0)) return true;
              if ((a[i] || 0) < (b[i] || 0)) return false;
            }
            return true;
          },
          setHeaderColor(color) { this.headerColor = color; hostPost('web_app_set_header_color', { color }); },
          setBackgroundColor(color) { this.backgroundColor = color; hostPost('web_app_set_background_color', { color }); },
          setBottomBarColor(color) { this.bottomBarColor = color; hostPost('web_app_set_bottom_bar_color', { color }); },
          enableClosingConfirmation() { this.isClosingConfirmationEnabled = true; },
          disableClosingConfirmation() { this.isClosingConfirmationEnabled = false; },
          enableVerticalSwipes() { this.isVerticalSwipesEnabled = true; },
          disableVerticalSwipes() { this.isVerticalSwipesEnabled = false; },
          MainButton: null,
          SecondaryButton: null,
          BackButton: null,
          SettingsButton: null,
          HapticFeedback: {
            impactOccurred() {}, notificationOccurred() {}, selectionChanged() {},
          },
          CloudStorage: {
            getItem(_k, cb) { if (cb) cb(null, null); },
            setItem(_k, _v, cb) { if (cb) cb(null, true); },
            removeItem(_k, cb) { if (cb) cb(null, true); },
            getItems(_k, cb) { if (cb) cb(null, {}); },
            removeItems(_k, cb) { if (cb) cb(null, true); },
            getKeys(cb) { if (cb) cb(null, []); },
          },
          BiometricManager: { isInited: true, isBiometricAvailable: false, init(cb) { if (cb) cb(); }, authenticate(_p, cb) { if (cb) cb(false); } },
        };
        WebApp.MainButton = buttonApi('main');
        WebApp.SecondaryButton = buttonApi('secondary');
        WebApp.BackButton = simpleButtonApi('backButtonClicked', 'back');
        WebApp.SettingsButton = simpleButtonApi('settingsButtonClicked', 'settings');
        window.Telegram = Object.assign(window.Telegram || {}, { WebApp });
        window.TelegramGameProxy = window.TelegramGameProxy || { receiveEvent: emit };
        window.TelegramWebviewProxy = window.TelegramWebviewProxy || {
          postEvent(eventType, eventData) {
            let data = eventData;
            if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
            hostPost(eventType, data || {});
          },
          receiveEvent: emit,
        };
        window.TelegramWebviewProxyProto = window.TelegramWebviewProxyProto || window.TelegramWebviewProxy;
        window.TelegramWebview = window.TelegramWebview || window.TelegramWebviewProxy;
        window.Android = window.Android || { postEvent: window.TelegramWebviewProxy.postEvent };
        try {
          window.external = window.external || {};
          window.external.notify = (raw) => {
            try {
              const msg = JSON.parse(raw);
              if (msg && msg.eventType) hostPost(msg.eventType, msg.eventData || {});
            } catch {}
          };
        } catch {}
        try {
          window.webkit = window.webkit || {};
          window.webkit.messageHandlers = window.webkit.messageHandlers || {};
          window.webkit.messageHandlers.TelegramWebviewProxy = window.webkit.messageHandlers.TelegramWebviewProxy || {
            postMessage(raw) {
              try {
                const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (msg && msg.eventType) window.TelegramWebviewProxy.postEvent(msg.eventType, msg.eventData || {});
              } catch {}
            },
          };
        } catch {}
        setTimeout(() => {
          emit('theme_changed', { theme_params: themeParams });
          emit('viewport_changed', { height: window.innerHeight, width: window.innerWidth, is_state_stable: true, is_expanded: true });
        }, 0);
      } catch (e) { console.warn('[telegram webapp shim failed]', e); }
    };
    installTelegramShim();
    const proxify = (raw) => {
      if (!raw) return raw;
      const s = String(raw);
      if (s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('mailto:') || s.startsWith('tel:') || s.startsWith('javascript:') || s.startsWith('#')) return s;
      try {
        // Resolve against upstream base so /foo → upstream/foo, not our origin.
        const abs = new URL(s, UPSTREAM);
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return s;
        // Already proxied? keep it proxied, but make sure the per-account
        // identity survives hardcoded JS URLs rewritten by the server.
        if (abs.origin === location.origin && abs.pathname.startsWith(PROXY_PREFIX)) {
          if (!abs.searchParams.get('a')) abs.searchParams.set('a', ACCT);
          if (!abs.searchParams.get('t')) abs.searchParams.set('t', TOKEN);
          if (FP_SEED && !abs.searchParams.get('fp')) abs.searchParams.set('fp', FP_SEED);
          if (CAP_ENABLED && !abs.searchParams.get('cap')) abs.searchParams.set('cap', '1');
          if (!abs.searchParams.get('r')) abs.searchParams.set('r', UPSTREAM);
          return abs.toString();
        }
        // Rewrite both same-preview paths and absolute upstream calls through the proxy.
        const target = (abs.origin === location.origin && upstreamOrigin)
          ? upstreamOrigin + abs.pathname + abs.search + abs.hash
          : abs.toString();
        const hashIdx = target.indexOf('#');
        const bare = hashIdx === -1 ? target : target.slice(0, hashIdx);
        const hash = hashIdx === -1 ? '' : target.slice(hashIdx);
        return location.origin + PROXY_PREFIX + encodeURIComponent(bare) + '?a=' + encodeURIComponent(ACCT) + '&t=' + encodeURIComponent(TOKEN) + (CAP_ENABLED ? '&cap=1' : '') + (FP_SEED ? '&fp=' + encodeURIComponent(FP_SEED) : '') + '&r=' + encodeURIComponent(UPSTREAM) + hash;
      } catch { return s; }
    };
    const isTgLink = (raw) => {
      try {
        const s = String(raw || '');
        return /^tg:\/\//i.test(s) || /^https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i.test(s);
      } catch { return false; }
    };
    const openInsideHost = (raw) => {
      if (!raw) return false;
      const s = String(raw);
      if (isTgLink(s)) {
        try {
          window.parent && window.parent.postMessage(JSON.stringify({ eventType: 'web_app_open_tg_link', eventData: { url: s } }), '*');
        } catch {}
        return true;
      }
      try {
        window.location.href = proxify(s);
        return true;
      } catch { return false; }
    };

    // Patch fetch
    try {
      const origFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        try {
          if (typeof input === 'string') input = proxify(input);
          else if (input && input.url) input = new Request(proxify(input.url), input);
        } catch {}
        return origFetch(input, init);
      };
    } catch {}

    // Patch XHR
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        try { arguments[1] = proxify(url); } catch {}
        return origOpen.apply(this, arguments);
      };
    } catch {}

    // Patch WebSocket / EventSource to upstream host
    try {
      const OrigWS = window.WebSocket;
      if (OrigWS && upstreamOrigin) {
        window.WebSocket = function(url, protocols) {
          try {
            const u = new URL(url, UPSTREAM);
            if (u.origin === location.origin) {
              u.protocol = u.protocol.replace('ws', location.protocol === 'https:' ? 'wss' : 'ws');
              const up = new URL(upstreamOrigin);
              u.host = up.host; u.protocol = up.protocol === 'https:' ? 'wss:' : 'ws:';
              url = u.toString();
            }
          } catch {}
          return protocols ? new OrigWS(url, protocols) : new OrigWS(url);
        };
        window.WebSocket.prototype = OrigWS.prototype;
      }
    } catch {}

    // Patch history + location assignments
    try {
      const origAssign = location.assign.bind(location);
      const origReplace = location.replace.bind(location);
      location.assign = (u) => origAssign(proxify(u));
      location.replace = (u) => origReplace(proxify(u));
      // location.href setter
      try {
        const desc = Object.getOwnPropertyDescriptor(Location.prototype, 'href') || Object.getOwnPropertyDescriptor(window.location, 'href');
        if (desc && desc.set) {
          Object.defineProperty(window.location, 'href', {
            configurable: true,
            get: desc.get ? desc.get.bind(window.location) : () => UPSTREAM,
            set: (v) => desc.set.call(window.location, proxify(v)),
          });
        }
      } catch {}
      const origPush = history.pushState.bind(history);
      const origRepl = history.replaceState.bind(history);
      history.pushState = function(s, t, u) { return origPush(s, t, u ? proxify(u) : u); };
      history.replaceState = function(s, t, u) { return origRepl(s, t, u ? proxify(u) : u); };
    } catch {}

    // Patch window.open — never create a browser tab from inside a mini-app tile.
    // Telegram links are handed to the parent tile; normal links navigate the iframe.
    try {
      window.open = function(u) { openInsideHost(u); return null; };
    } catch {}

    // Intercept anchor clicks & form submits (catches links added dynamically)
    try {
      document.addEventListener('click', (e) => {
        const a = e.target && (e.target.closest ? e.target.closest('a[href]') : null);
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href) return;
        e.preventDefault();
        e.stopPropagation();
        openInsideHost(href);
      }, true);
      document.addEventListener('submit', (e) => {
        const f = e.target;
        if (!f || !f.getAttribute) return;
        const action = f.getAttribute('action');
        if (!action) return;
        f.setAttribute('target', '_self');
        const proxied = proxify(action);
        if (proxied !== action) f.setAttribute('action', proxied);
      }, true);
    } catch {}

    const nav = Object.getPrototypeOf(navigator);
    const set = (obj, key, val) => {
      try { Object.defineProperty(obj, key, { get: () => val, configurable: true }); } catch (e) {}
    };
    const platformName = fp.platform.includes('iPhone') ? 'iOS' : fp.mobile ? 'Android' : 'Linux';
    const isIOS = platformName === 'iOS';
    const chromeVersion = (fp.userAgent.split('Chrome/')[1] || '').split('.')[0] || '120';
    const mobileModel = (() => {
      try {
        const androidPart = fp.userAgent.split('; Android ')[1] || '';
        const modelPart = androidPart.split(') AppleWebKit')[0].split(';').pop();
        return (modelPart || 'Pixel 7').trim();
      } catch { return 'Pixel 7'; }
    })();
    const brands = Object.freeze([
      { brand: 'Chromium', version: chromeVersion },
      { brand: 'Google Chrome', version: chromeVersion },
      { brand: 'Not:A-Brand', version: '99' },
    ]);
    const uaData = isIOS ? undefined : {
      brands,
      mobile: fp.mobile,
      platform: platformName,
      getHighEntropyValues(hints) {
        const values = {
          brands,
          mobile: fp.mobile,
          platform: platformName,
          architecture: fp.mobile ? '' : (fp.platform.includes('Win') ? 'x86' : 'arm'),
          bitness: fp.mobile ? '' : '64',
          model: fp.mobile ? mobileModel : '',
          platformVersion: fp.userAgent.includes('Android 13') ? '13.0.0' : fp.userAgent.includes('Android 12') ? '12.0.0' : '14.0.0',
          uaFullVersion: chromeVersion + '.0.0.0',
          fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === 'Not:A-Brand' ? '99.0.0.0' : chromeVersion + '.0.0.0' })),
          wow64: false,
        };
        const out = { brands, mobile: fp.mobile, platform: platformName };
        (Array.isArray(hints) ? hints : []).forEach((h) => { if (h in values) out[h] = values[h]; });
        return Promise.resolve(out);
      },
      toJSON() { return { brands, mobile: fp.mobile, platform: platformName }; },
    };
    ['userAgent', 'appVersion', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'vendor', 'webdriver', 'userAgentData'].forEach((key) => {
      const val = key === 'userAgent' ? TELEGRAM_UA
        : key === 'appVersion' ? TELEGRAM_UA.replace(/^Mozilla\\//, '')
        : key === 'platform' ? fp.platform
        : key === 'language' ? fp.languages[0]
        : key === 'languages' ? Object.freeze(fp.languages.slice())
        : key === 'hardwareConcurrency' ? fp.hardwareConcurrency
        : key === 'deviceMemory' ? fp.deviceMemory
        : key === 'maxTouchPoints' ? (fp.mobile ? 5 : 0)
        : key === 'vendor' ? (isIOS ? 'Apple Computer, Inc.' : 'Google Inc.')
        : key === 'webdriver' ? undefined
        : uaData;
      set(nav, key, val);
      set(navigator, key, val);
    });
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
            const original = new Uint8ClampedArray(img.data);
            jitter(img.data);
            ctx.putImageData(img, 0, 0);
            const out = origToDataURL.apply(this, arguments);
            img.data.set(original);
            ctx.putImageData(img, 0, 0);
            return out;
          }
        } catch (e) {}
        return origToDataURL.apply(this, arguments);
      };
    } catch (e) {}
    // Stable unique storage namespace without credentialless iframes. This keeps
    // Lovable preview/auth cookies available for the proxy route, while each
    // Telegram account still gets isolated mini-app localStorage/sessionStorage.
    try {
      window.name = 'acct-' + fp.hashKey;
      const ns = 'tgmini:' + fp.hashKey + ':' + (upstreamOrigin || 'unknown') + ':';
      const realLocalStorage = window.localStorage;
      const realSessionStorage = window.sessionStorage;
      const wrapStorage = (store) => ({
        get length() {
          let n = 0;
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k && k.startsWith(ns)) n++;
          }
          return n;
        },
        key(i) {
          let n = 0;
          for (let x = 0; x < store.length; x++) {
            const k = store.key(x);
            if (!k || !k.startsWith(ns)) continue;
            if (n === i) return k.slice(ns.length);
            n++;
          }
          return null;
        },
        getItem(k) { return store.getItem(ns + String(k)); },
        setItem(k, v) { return store.setItem(ns + String(k), String(v)); },
        removeItem(k) { return store.removeItem(ns + String(k)); },
        clear() {
          const keys = [];
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k && k.startsWith(ns)) keys.push(k);
          }
          keys.forEach((k) => store.removeItem(k));
        },
      });
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => wrapStorage(realLocalStorage) });
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => wrapStorage(realSessionStorage) });
    } catch (e) {}
  } catch (err) { console.warn('[fingerprint override failed]', err); }
  ${captchaBridge}
})();`;
}

function proxyUrl(target: string, accountId: string, token: string, proxyOrigin = "") {
  return `${proxyOrigin}/api/public/miniapp-proxy/${encodeURIComponent(target)}?a=${encodeURIComponent(accountId)}&t=${encodeURIComponent(token)}`;
}

function rewriteHtmlUrls(html: string, baseUrl: string, accountId: string, token: string, proxyOrigin: string) {
  const base = new URL(baseUrl);
  const toProxy = (raw: string) => {
    if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) {
      return raw;
    }
    try {
      const absolute = new URL(raw, base).toString();
      if (!/^https?:\/\//i.test(absolute)) return raw;
      return proxyUrl(absolute, accountId, token, proxyOrigin);
    } catch {
      return raw;
    }
  };

  return html
    .replace(/<meta\s+[^>]*http-equiv=(['"])content-security-policy\1[^>]*>/gi, "")
    .replace(/\s(?:integrity|nonce)=(['"])[\s\S]*?\1/gi, "")
    .replace(/\b(src|href|action)=(['"])(.*?)\2/gi, (_m, attr, quote, value) => `${attr}=${quote}${toProxy(value)}${quote}`)
    .replace(/\bsrcset=(['"])(.*?)\1/gi, (_m, quote, value) => {
      const rewritten = String(value)
        .split(",")
        .map((part) => {
          const trimmed = part.trim();
          const [urlPart, ...rest] = trimmed.split(/\s+/);
          return [toProxy(urlPart), ...rest].join(" ");
        })
        .join(", ");
      return `srcset=${quote}${rewritten}${quote}`;
    });
}

function rewriteCssUrls(css: string, baseUrl: string, accountId: string, token: string, proxyOrigin: string) {
  const base = new URL(baseUrl);
  return css.replace(/url\((['"]?)(.*?)\1\)/gi, (_m, quote, value) => {
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) return `url(${quote}${value}${quote})`;
    try {
      return `url(${quote}${proxyUrl(new URL(value, base).toString(), accountId, token, proxyOrigin)}${quote})`;
    } catch {
      return `url(${quote}${value}${quote})`;
    }
  });
}

function rewriteJsUrls(js: string, baseUrl: string, accountId: string, token: string, proxyOrigin: string) {
  try {
    const upstream = new URL(baseUrl);
    // Note: the resulting URL will not have query params; the client-side
    // proxify shim adds `?a=` and `?t=` when the browser loads the resource.
    const proxyBase = `${proxyOrigin}/api/public/miniapp-proxy/${encodeURIComponent(upstream.origin)}`;
    void token;
    return js.replaceAll(upstream.origin, proxyBase);
  } catch {
    return js;
  }
}

async function handle(request: Request, params: { _splat?: string }) {
  const target = params._splat ? decodeURIComponent(params._splat) : "";
  if (!target || !/^https?:\/\//.test(target)) {
    return new Response("Missing target URL", { status: 400 });
  }
  const proxyReqUrl = new URL(request.url);
  const proxyOrigin = proxyReqUrl.origin;
  const accountId = proxyReqUrl.searchParams.get("a") || "anon";
  const token = proxyReqUrl.searchParams.get("t") || readTokenCookie(request);
  const captchaEnabled = proxyReqUrl.searchParams.get("cap") === "1";
  const cookieJar = readCookieJar(request);
  // Optional per-run fingerprint seed. When present, the derived
  // navigator/screen/timezone/UA identity varies even for the same
  // account, so the bot sees a different "device" on each run.
  const fpSeed = proxyReqUrl.searchParams.get("fp") || "";
  const identityKey = fpSeed ? `${accountId}:${fpSeed}` : accountId;

  // Auth: require a valid short-lived HMAC token (minted by an authenticated
  // server function). Blocks anonymous use of the proxy as an open relay.
  if (!verifyMiniAppProxyToken(token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // SSRF guard: reject loopback, link-local, cloud metadata, and private
  // network destinations at the hostname layer.
  let targetUrlEarly: URL;
  try {
    targetUrlEarly = new URL(target);
  } catch {
    return new Response("Invalid target URL", { status: 400 });
  }
  if (isBlockedProxyHost(targetUrlEarly.hostname)) {
    return new Response("Target host is not permitted", { status: 403 });
  }

  const upstreamHeaders = new Headers();
  const fp = deriveMiniAppIdentity(identityKey).fingerprint;
  const targetUrl = targetUrlEarly;
  copyBrowserRequestHeaders(request, upstreamHeaders);
  upstreamHeaders.set("user-agent", toTelegramUserAgent(fp));
  upstreamHeaders.set("x-requested-with", "org.telegram.messenger");
  upstreamHeaders.set("accept-language", fp.languages.join(","));
  setClientHintHeaders(upstreamHeaders, fp);
  const referrerUrl = safeHeaderReferrer(proxyReqUrl.searchParams.get("r"), targetUrl.toString());
  upstreamHeaders.set("origin", referrerUrl.origin);
  upstreamHeaders.set("referer", referrerUrl.toString());
  const accept = request.headers.get("accept");
  if (accept) upstreamHeaders.set("accept", accept);
  // Some anti-bot / CDN layers serve a placeholder image (rendered as a
  // broken-image icon in the iframe) when the request looks non-browser or
  // when a top-level navigation lacks Sec-Fetch metadata. Force navigation-
  // shaped Accept + Sec-Fetch headers on the first hop of a document request.
  const secFetchDest = request.headers.get("sec-fetch-dest");
  const isDocumentNav =
    secFetchDest === "document" ||
    secFetchDest === "iframe" ||
    (request.method === "GET" && !!accept?.toLowerCase().includes("text/html"));
  if (isDocumentNav) {
    upstreamHeaders.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    );
    upstreamHeaders.set("sec-fetch-mode", "navigate");
    upstreamHeaders.set("sec-fetch-dest", "document");
    upstreamHeaders.set("sec-fetch-site", "none");
    upstreamHeaders.set("sec-fetch-user", "?1");
    upstreamHeaders.set("upgrade-insecure-requests", "1");
    // Drop cross-origin origin/referer for a top-level nav — browsers do not
    // send them and some WAFs 403 when they see a mismatched origin.
    upstreamHeaders.delete("origin");
    upstreamHeaders.delete("referer");
  }
  const contentType = request.headers.get("content-type");
  if (contentType) upstreamHeaders.set("content-type", contentType);
  const requestedWith = request.headers.get("x-requested-with");
  if (requestedWith && requestedWith.toLowerCase().includes("telegram")) upstreamHeaders.set("x-requested-with", requestedWith);

  let upstream: Response;
  try {
    // SSRF-safe redirect handling: follow redirects manually and re-run the
    // block-list guard against every hop's hostname. Prevents a redirect (or
    // DNS-rebound host) from steering the outbound fetch at loopback,
    // link-local, RFC1918, or cloud-metadata addresses after the initial
    // hostname check passed.
    const method = request.method;
    const bodyBuf = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    let currentUrl = target;
    // Optional outbound IP rotation. If MINIAPP_PROXY_URL_TEMPLATE is set
    // (e.g. "https://proxy.example.com/fetch?url={url}&session={session}"),
    // route every upstream fetch through it. `{session}` receives a
    // per-run token so a rotating-proxy service assigns a fresh exit IP.
    const proxyTemplate = process.env.MINIAPP_PROXY_URL_TEMPLATE || "";
    const proxySession = fpSeed || identityKey;
    const viaProxy = (u: string) =>
      proxyTemplate
        ? proxyTemplate
            .replace("{url}", encodeURIComponent(u))
            .replace("{session}", encodeURIComponent(proxySession))
        : u;
    const MAX_REDIRECTS = 5;
    let hop = 0;
    while (true) {
      const currentTargetUrl = new URL(currentUrl);
      const upstreamCookie = cookieHeaderForTarget(cookieJar, currentTargetUrl);
      if (upstreamCookie) upstreamHeaders.set("cookie", upstreamCookie);
      else upstreamHeaders.delete("cookie");
      const resp = await fetch(viaProxy(currentUrl), {
        method,
        headers: upstreamHeaders,
        body: bodyBuf,
        redirect: "manual",
      });
      mergeSetCookies(cookieJar, currentTargetUrl, getSetCookieHeaders(resp.headers));
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
        if (++hop > MAX_REDIRECTS) {
          return new Response("Too many redirects", { status: 502 });
        }
        let next: URL;
        try {
          next = new URL(resp.headers.get("location")!, currentUrl);
        } catch {
          return new Response("Invalid redirect target", { status: 502 });
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return new Response("Redirect scheme not permitted", { status: 502 });
        }
        if (isBlockedProxyHost(next.hostname)) {
          return new Response("Redirect target host is not permitted", { status: 403 });
        }
        currentUrl = next.toString();
        if (!isDocumentNav) {
          const hopReferrer = safeHeaderReferrer(currentTargetUrl.toString(), next.toString());
          upstreamHeaders.set("origin", hopReferrer.origin);
          upstreamHeaders.set("referer", hopReferrer.toString());
        }
        continue;
      }
      upstream = resp;
      break;
    }
  } catch (e) {
    return new Response(`Upstream fetch failed: ${(e as Error).message}`, { status: 502 });
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!STRIP_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
  });
  outHeaders.set("access-control-allow-origin", "*");
  // Debug headers so operators can see exactly what the upstream returned
  // without stepping into server logs. Visible in DevTools → Network.
  outHeaders.set("x-proxy-upstream-status", String(upstream.status));
  outHeaders.set("x-proxy-upstream-ctype", upstream.headers.get("content-type") || "(none)");
  outHeaders.set("x-proxy-upstream-url", upstream.url || target);
  // Never let the browser cache proxy responses — the token, cookie, and
  // upstream state all change per request.
  outHeaders.set("cache-control", "no-store, no-cache, must-revalidate");
  outHeaders.set("pragma", "no-cache");
  console.log("[miniapp-proxy]", {
    status: upstream.status,
    ctype: upstream.headers.get("content-type"),
    url: upstream.url || target,
    accountId,
  });
  // Backup cookie: subsequent sub-resource requests from the iframe carry
  // the token even if the URL rewriter missed an inline reference.
  outHeaders.append(
    "set-cookie",
    `miniapp_proxy_t=${encodeURIComponent(token!)}; Path=/api/public/miniapp-proxy/; Max-Age=3600; HttpOnly; Secure; SameSite=None`,
  );
  outHeaders.append(
    "set-cookie",
    `${COOKIE_JAR_NAME}=${encodeURIComponent(serializeCookieJar(cookieJar))}; Path=/api/public/miniapp-proxy/; Max-Age=3600; HttpOnly; Secure; SameSite=None`,
  );

  const ctype = upstream.headers.get("content-type") || "";
  if (ctype.includes("text/html")) {
    let html = await upstream.text();
    const finalUrl = upstream.url || target;
    const upstreamDir = new URL(".", finalUrl).toString();
    const script = `<script>${buildOverrideScript(accountId, finalUrl, token!, captchaEnabled, fpSeed)}</script>`;
    const base = `<base href="${upstreamDir}">`;
    html = rewriteHtmlUrls(html, finalUrl, accountId, token!, proxyOrigin);
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${script}${base}`);
    } else {
      html = `${base}${script}${html}`;
    }
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(html, { status: upstream.status, headers: outHeaders });
  }
  if (ctype.includes("text/css")) {
    const css = rewriteCssUrls(await upstream.text(), upstream.url || target, accountId, token!, proxyOrigin);
    outHeaders.set("content-type", "text/css; charset=utf-8");
    return new Response(css, { status: upstream.status, headers: outHeaders });
  }
  if (ctype.includes("javascript") || ctype.includes("ecmascript") || /\.m?js(?:$|\?)/i.test(target)) {
    const js = rewriteJsUrls(await upstream.text(), upstream.url || target, accountId, token!, proxyOrigin);
    outHeaders.set("content-type", ctype || "application/javascript; charset=utf-8");
    return new Response(js, { status: upstream.status, headers: outHeaders });
  }
  // Top-level navigation that came back as an image / octet-stream almost
  // always means the upstream (or a CDN in front of it) served an anti-bot
  // placeholder. Chrome would render that as a broken-image icon inside the
  // iframe — swap it for a readable HTML error so the operator can react.
  if (
    isDocumentNav &&
    (ctype.startsWith("image/") || ctype.includes("octet-stream") || !ctype)
  ) {
    const finalUrl = upstream.url || target;
    const msg = `<!doctype html><meta charset="utf-8"><title>Upstream blocked</title>
<div style="font:14px system-ui;padding:24px;color:#111;background:#fff8e1;border:1px solid #f3d27a;border-radius:8px;margin:16px">
  <h2 style="margin:0 0 8px">Upstream returned a non-HTML response</h2>
  <div><b>Status:</b> ${upstream.status}</div>
  <div><b>Content-Type:</b> ${ctype || "(none)"}</div>
  <div style="word-break:break-all"><b>URL:</b> ${finalUrl}</div>
  <p>The bot's server likely detected the proxy and served a placeholder image
  instead of the mini-app. Try the original <code>t.me/&hellip;?startapp=</code>
  link, refresh from your Telegram account, or wait a minute and retry.</p>
</div>`;
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(msg, { status: 502, headers: outHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

function readTokenCookie(request: Request): string | null {
  return readCookieValue(request, "miniapp_proxy_t");
}

export const Route = createFileRoute("/api/public/miniapp-proxy/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => handle(request, params),
      POST: ({ request, params }) => handle(request, params),
    },
  },
});