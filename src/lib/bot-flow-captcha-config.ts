import { useSyncExternalStore } from "react";

export type BotFlowCaptchaKind =
  | "auto" | "math" | "buttonChoice" | "image"
  | "recaptchaV2" | "recaptchaV3" | "hcaptcha" | "turnstile"
  | "geetest" | "geetestV4" | "funcaptcha" | "datadome" | "mtcaptcha"
  | "friendlyCaptcha" | "amazonWaf" | "capy" | "keycaptcha"
  | "lemin" | "cutcaptcha" | "atbCaptcha" | "prosopo" | "tencent";

export type BotFlowCaptchaProvider = "auto" | "twocaptcha" | "anticaptcha" | "capsolver" | "ai";

export const CAPTCHA_KIND_OPTIONS: { value: BotFlowCaptchaKind; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "math", label: "Math / word puzzle (AI)" },
  { value: "buttonChoice", label: "Button-choice (AI)" },
  { value: "image", label: "Image / text captcha" },
  { value: "recaptchaV2", label: "reCAPTCHA v2" },
  { value: "recaptchaV3", label: "reCAPTCHA v3" },
  { value: "hcaptcha", label: "hCaptcha" },
  { value: "turnstile", label: "Cloudflare Turnstile" },
  { value: "geetest", label: "GeeTest v3" },
  { value: "geetestV4", label: "GeeTest v4" },
  { value: "funcaptcha", label: "FunCaptcha / Arkose" },
  { value: "datadome", label: "DataDome" },
  { value: "mtcaptcha", label: "MTCaptcha" },
  { value: "friendlyCaptcha", label: "Friendly Captcha" },
  { value: "amazonWaf", label: "Amazon WAF" },
  { value: "capy", label: "Capy Puzzle" },
  { value: "keycaptcha", label: "KeyCaptcha" },
  { value: "lemin", label: "Lemin Cropped" },
  { value: "cutcaptcha", label: "CutCaptcha" },
  { value: "atbCaptcha", label: "AtbCAPTCHA" },
  { value: "prosopo", label: "Prosopo Procaptcha" },
  { value: "tencent", label: "Tencent Captcha" },
];

export const CAPTCHA_PROVIDER_OPTIONS: { value: BotFlowCaptchaProvider; label: string }[] = [
  { value: "auto", label: "Auto (priority order)" },
  { value: "twocaptcha", label: "2Captcha" },
  { value: "anticaptcha", label: "Anti-Captcha" },
  { value: "capsolver", label: "CapSolver" },
  { value: "ai", label: "Built-in AI vision only" },
];

export interface BotFlowCaptchaConfig {
  enabled: boolean;
  kind: BotFlowCaptchaKind;
  provider: BotFlowCaptchaProvider;
}

const KEY = "botflow-captcha-config-v1";
const DEFAULT: BotFlowCaptchaConfig = { enabled: false, kind: "auto", provider: "auto" };

// Cache the parsed snapshot so useSyncExternalStore always sees the SAME
// object reference between renders unless the underlying JSON changed.
// Returning `{ ...DEFAULT, ...parsed }` on every call created a new object
// each time, which put React into an infinite re-render loop and made the
// whole bot-flow route crash into the error boundary as soon as a config
// was persisted to localStorage.
let cachedRaw: string | null | undefined = undefined;
let cachedSnap: BotFlowCaptchaConfig = DEFAULT;
function read(): BotFlowCaptchaConfig {
  if (typeof window === "undefined") return DEFAULT;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return DEFAULT;
  }
  if (raw === cachedRaw) return cachedSnap;
  cachedRaw = raw;
  if (!raw) {
    cachedSnap = DEFAULT;
    return cachedSnap;
  }
  try {
    cachedSnap = { ...DEFAULT, ...(JSON.parse(raw) as Partial<BotFlowCaptchaConfig>) };
  } catch {
    cachedSnap = DEFAULT;
  }
  return cachedSnap;
}

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) cb(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setBotFlowCaptchaConfig(patch: Partial<BotFlowCaptchaConfig>) {
  const next = { ...read(), ...patch };
  if (typeof window !== "undefined") {
    const serialized = JSON.stringify(next);
    window.localStorage.setItem(KEY, serialized);
    // Update cache in-place so the next `read()` returns the fresh snapshot
    // without needing another parse.
    cachedRaw = serialized;
    cachedSnap = next;
  }
  listeners.forEach((cb) => cb());
}

export function useBotFlowCaptchaConfig(): [BotFlowCaptchaConfig, (p: Partial<BotFlowCaptchaConfig>) => void] {
  const cfg = useSyncExternalStore(subscribe, read, () => DEFAULT);
  return [cfg, setBotFlowCaptchaConfig];
}