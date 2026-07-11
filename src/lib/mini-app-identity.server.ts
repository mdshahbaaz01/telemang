// Deterministic per-account Mini App identity. Telegram signs the
// tgWebAppData/tgWebAppPlatform into the resolved URL, so varying these
// per account gives each account a distinct "device" fingerprint for bots
// that rely on platform + theme + colour scheme in initData.

const PLATFORMS = ["android", "ios", "tdesktop", "macos", "weba", "web"] as const;

type Theme = {
  bg_color: string;
  text_color: string;
  hint_color: string;
  link_color: string;
  button_color: string;
  button_text_color: string;
  secondary_bg_color: string;
  header_bg_color: string;
  accent_text_color: string;
  section_bg_color: string;
  section_header_text_color: string;
  subtitle_text_color: string;
  destructive_text_color: string;
};

const LIGHT: Theme = {
  bg_color: "#ffffff",
  text_color: "#000000",
  hint_color: "#707579",
  link_color: "#3390ec",
  button_color: "#3390ec",
  button_text_color: "#ffffff",
  secondary_bg_color: "#f1f1f1",
  header_bg_color: "#ffffff",
  accent_text_color: "#3390ec",
  section_bg_color: "#ffffff",
  section_header_text_color: "#3390ec",
  subtitle_text_color: "#707579",
  destructive_text_color: "#df3f40",
};

const DARK: Theme = {
  bg_color: "#17212b",
  text_color: "#ffffff",
  hint_color: "#708499",
  link_color: "#6ab3f3",
  button_color: "#5288c1",
  button_text_color: "#ffffff",
  secondary_bg_color: "#232e3c",
  header_bg_color: "#17212b",
  accent_text_color: "#6ab3f3",
  section_bg_color: "#17212b",
  section_header_text_color: "#6ab3f3",
  subtitle_text_color: "#708499",
  destructive_text_color: "#ec3942",
};

export function deriveMiniAppIdentity(key: string) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  const platform = PLATFORMS[h % PLATFORMS.length];
  const dark = (h >> 4) % 2 === 0;
  return {
    platform,
    colorScheme: dark ? "dark" : "light",
    themeParams: dark ? DARK : LIGHT,
    fingerprint: deriveFingerprint(key, h),
  };
}

// Deterministic browser fingerprint for a given account. Used by the
// mini-app proxy to override navigator/screen/timezone/canvas so bot
// verification systems that read Web APIs see a distinct device per account.
const UA_TEMPLATES = [
  // Android Chrome
  { platform: "Linux armv8l", ua: (v: number) => `Mozilla/5.0 (Linux; Android 14; Pixel ${6 + (v % 4)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${118 + (v % 8)}.0.0.0 Mobile Safari/537.36`, w: 412, h: 915, dpr: 2.625, mobile: true },
  { platform: "Linux armv8l", ua: (v: number) => `Mozilla/5.0 (Linux; Android 13; SM-S91${v % 9}B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${117 + (v % 6)}.0.0.0 Mobile Safari/537.36`, w: 384, h: 854, dpr: 2.75, mobile: true },
  // iOS Safari
  { platform: "iPhone", ua: (v: number) => `Mozilla/5.0 (iPhone; CPU iPhone OS 17_${v % 6} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.${v % 5} Mobile/15E148 Safari/604.1`, w: 390, h: 844, dpr: 3, mobile: true },
  { platform: "iPhone", ua: (v: number) => `Mozilla/5.0 (iPhone; CPU iPhone OS 16_${v % 7} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.${v % 6} Mobile/15E148 Safari/604.1`, w: 375, h: 812, dpr: 3, mobile: true },
  // Desktop
  { platform: "Win32", ua: (v: number) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${118 + (v % 8)}.0.0.0 Safari/537.36`, w: 1536, h: 864, dpr: 1.25, mobile: false },
  { platform: "MacIntel", ua: (v: number) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.${v % 4} Safari/605.1.15`, w: 1440, h: 900, dpr: 2, mobile: false },
];

const TIMEZONES = [
  "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Bangkok", "Asia/Jakarta",
  "Europe/London", "Europe/Berlin", "Europe/Warsaw", "America/New_York", "America/Chicago",
  "America/Los_Angeles", "America/Sao_Paulo", "Australia/Sydney",
];

const LANGS = [
  ["en-IN", "en", "hi"], ["en-US", "en"], ["en-GB", "en"], ["hi-IN", "hi", "en"],
  ["id-ID", "id", "en"], ["pt-BR", "pt", "en"], ["ru-RU", "ru", "en"],
  ["de-DE", "de", "en"], ["fr-FR", "fr", "en"], ["es-ES", "es", "en"],
];

function deriveFingerprint(key: string, h: number) {
  const tpl = UA_TEMPLATES[h % UA_TEMPLATES.length];
  const uaVer = (h >> 3) & 0xff;
  const tz = TIMEZONES[(h >> 7) % TIMEZONES.length];
  const langs = LANGS[(h >> 11) % LANGS.length];
  const cores = [2, 4, 6, 8, 12][(h >> 13) % 5];
  const memory = [2, 4, 6, 8][(h >> 15) % 4];
  const canvasSeed = ((h * 2654435761) >>> 0) / 0xffffffff;
  return {
    userAgent: tpl.ua(uaVer),
    platform: tpl.platform,
    mobile: tpl.mobile,
    screenW: tpl.w,
    screenH: tpl.h,
    dpr: tpl.dpr,
    timezone: tz,
    languages: langs,
    hardwareConcurrency: cores,
    deviceMemory: memory,
    canvasSeed,
    hashKey: `k${h.toString(36)}`,
  };
}