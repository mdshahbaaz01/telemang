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
  };
}