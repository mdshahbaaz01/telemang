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

function buildOverrideScript(accountId: string, upstreamUrl: string) {
  const fp = deriveMiniAppIdentity(accountId).fingerprint;
  return `(() => {
  try {
    const fp = ${JSON.stringify(fp)};
    const ACCT = ${JSON.stringify(accountId)};
    const UPSTREAM = ${JSON.stringify(upstreamUrl)};
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
        const hashParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
        const initData = hashParams.get('tgWebAppData') || '';
        const themeRaw = hashParams.get('tgWebAppThemeParams') || '';
        const themeParams = themeRaw ? (parseMaybeJson(themeRaw) || {}) : {};
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
          version: hashParams.get('tgWebAppVersion') || '8.0',
          platform: hashParams.get('tgWebAppPlatform') || 'web',
          colorScheme: Object.keys(themeParams).length && String(themeParams.bg_color || '').toLowerCase() !== '#ffffff' ? 'dark' : 'light',
          themeParams,
          isExpanded: true,
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
          close() { hostPost('web_app_close', {}); },
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
        };
        try {
          window.external = window.external || {};
          window.external.notify = (raw) => {
            try {
              const msg = JSON.parse(raw);
              if (msg && msg.eventType) hostPost(msg.eventType, msg.eventData || {});
            } catch {}
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
        // Already proxied? leave alone.
        if (abs.origin === location.origin && abs.pathname.startsWith(PROXY_PREFIX)) return s;
        // If it points at our origin (mini-app used location.href/fetch with a path), rewrite to upstream host.
        const target = (abs.origin === location.origin && upstreamOrigin)
          ? upstreamOrigin + abs.pathname + abs.search + abs.hash
          : abs.toString();
        const hashIdx = target.indexOf('#');
        const bare = hashIdx === -1 ? target : target.slice(0, hashIdx);
        const hash = hashIdx === -1 ? '' : target.slice(hashIdx);
        return location.origin + PROXY_PREFIX + encodeURIComponent(bare) + '?a=' + encodeURIComponent(ACCT) + hash;
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
    const platformName = fp.platform.includes('iPhone') ? 'iOS' : fp.platform.includes('Mac') ? 'macOS' : fp.platform.includes('Win') ? 'Windows' : fp.mobile ? 'Android' : 'Linux';
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
    const uaData = {
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
          platformVersion: fp.mobile ? '14.0.0' : fp.platform.includes('Win') ? '15.0.0' : '14.0.0',
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
      const val = key === 'userAgent' ? fp.userAgent
        : key === 'appVersion' ? fp.userAgent.replace(/^Mozilla\\//, '')
        : key === 'platform' ? fp.platform
        : key === 'language' ? fp.languages[0]
        : key === 'languages' ? Object.freeze(fp.languages.slice())
        : key === 'hardwareConcurrency' ? fp.hardwareConcurrency
        : key === 'deviceMemory' ? fp.deviceMemory
        : key === 'maxTouchPoints' ? (fp.mobile ? 5 : 0)
        : key === 'vendor' ? (fp.platform === 'iPhone' || fp.platform === 'MacIntel' ? 'Apple Computer, Inc.' : 'Google Inc.')
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
})();`;
}

function proxyUrl(target: string, accountId: string, proxyOrigin = "") {
  return `${proxyOrigin}/api/public/miniapp-proxy/${encodeURIComponent(target)}?a=${encodeURIComponent(accountId)}`;
}

function rewriteHtmlUrls(html: string, baseUrl: string, accountId: string, proxyOrigin: string) {
  const base = new URL(baseUrl);
  const toProxy = (raw: string) => {
    if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) {
      return raw;
    }
    try {
      const absolute = new URL(raw, base).toString();
      if (!/^https?:\/\//i.test(absolute)) return raw;
      return proxyUrl(absolute, accountId, proxyOrigin);
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

function rewriteCssUrls(css: string, baseUrl: string, accountId: string, proxyOrigin: string) {
  const base = new URL(baseUrl);
  return css.replace(/url\((['"]?)(.*?)\1\)/gi, (_m, quote, value) => {
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) return `url(${quote}${value}${quote})`;
    try {
      return `url(${quote}${proxyUrl(new URL(value, base).toString(), accountId, proxyOrigin)}${quote})`;
    } catch {
      return `url(${quote}${value}${quote})`;
    }
  });
}

async function handle(request: Request, params: { _splat?: string }) {
  const target = params._splat ? decodeURIComponent(params._splat) : "";
  if (!target || !/^https?:\/\//.test(target)) {
    return new Response("Missing target URL", { status: 400 });
  }
  const proxyReqUrl = new URL(request.url);
  const proxyOrigin = proxyReqUrl.origin;
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
    const finalUrl = upstream.url || target;
    const upstreamDir = new URL(".", finalUrl).toString();
    const script = `<script>${buildOverrideScript(accountId, finalUrl)}</script>`;
    const base = `<base href="${upstreamDir}">`;
    html = rewriteHtmlUrls(html, finalUrl, accountId, proxyOrigin);
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${script}${base}`);
    } else {
      html = `${base}${script}${html}`;
    }
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(html, { status: upstream.status, headers: outHeaders });
  }
  if (ctype.includes("text/css")) {
    const css = rewriteCssUrls(await upstream.text(), upstream.url || target, accountId, proxyOrigin);
    outHeaders.set("content-type", "text/css; charset=utf-8");
    return new Response(css, { status: upstream.status, headers: outHeaders });
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