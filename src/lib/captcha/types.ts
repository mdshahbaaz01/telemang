export type CaptchaProvider = "twocaptcha" | "anticaptcha" | "capsolver";

export type CaptchaKind =
  | "image"           // base64 image → text answer
  | "recaptchaV2"     // sitekey + pageUrl → g-recaptcha token
  | "recaptchaV3"     // sitekey + pageUrl + action + minScore → token
  | "hcaptcha"        // sitekey + pageUrl → h-captcha token
  | "turnstile"       // sitekey + pageUrl → cf-turnstile token
  | "math"            // AI vision/text: solve "3+7=?" → number
  | "buttonChoice"    // AI vision: pick which image button matches prompt
  | "geetest"         // GeeTest v3 (challenge + gt + pageUrl)
  | "geetestV4"       // GeeTest v4 (captcha_id + pageUrl)
  | "funcaptcha"      // Arkose Labs / FunCaptcha (publickey + surl + pageUrl)
  | "keycaptcha"      // KeyCaptcha (s_s_c_*, pageUrl)
  | "capy"            // Capy Puzzle (sitekey + pageUrl)
  | "mtcaptcha"       // MTCaptcha (sitekey + pageUrl)
  | "friendlyCaptcha" // Friendly Captcha (sitekey + pageUrl)
  | "amazonWaf"       // Amazon WAF (sitekey + iv + context + pageUrl)
  | "datadome"        // DataDome (captcha_url + userAgent + pageUrl)
  | "lemin"           // Lemin Cropped (captcha_id + div_id + pageUrl)
  | "cutcaptcha"      // CutCaptcha (misery_key + apikey + pageUrl)
  | "atbCaptcha"      // AtbCAPTCHA (app_id + api_server + pageUrl)
  | "prosopo"         // Prosopo Procaptcha (siteKey + pageUrl)
  | "tencent"         // Tencent Captcha (app_id + pageUrl)
  | "coordinates"     // click coordinates on image
  | "grid"            // grid image click puzzle
  | "rotate"          // rotate image to correct angle
  | "canvas"          // canvas draw puzzle
  | "audio";          // audio captcha (base64 wav/mp3)

export interface SolveRequestBase {
  kind: CaptchaKind;
  accountId?: string | null;
  context?: Record<string, unknown>;
}

export interface ImageSolveRequest extends SolveRequestBase {
  kind: "image";
  imageBase64: string;      // no data: prefix
  hint?: string;            // optional instructions ("digits only", "6 chars")
  numeric?: boolean;
  minLength?: number;
  maxLength?: number;
  caseSensitive?: boolean;
}

export interface WebSolveRequest extends SolveRequestBase {
  kind:
    | "recaptchaV2" | "recaptchaV3" | "hcaptcha" | "turnstile"
    | "geetest" | "geetestV4" | "funcaptcha" | "keycaptcha" | "capy"
    | "mtcaptcha" | "friendlyCaptcha" | "amazonWaf" | "datadome"
    | "lemin" | "cutcaptcha" | "atbCaptcha" | "prosopo" | "tencent";
  sitekey: string;
  pageUrl: string;
  action?: string;      // recaptchaV3
  minScore?: number;    // recaptchaV3
  invisible?: boolean;  // recaptchaV2
  data?: string;        // turnstile cData
  action_turnstile?: string;
  extra?: Record<string, string | number | boolean>; // provider-specific extras
}

export interface MathSolveRequest extends SolveRequestBase {
  kind: "math";
  text?: string;            // e.g. "What is 3 + 7?"
  imageBase64?: string;     // OR an image containing math
}

export interface ButtonChoiceRequest extends SolveRequestBase {
  kind: "buttonChoice";
  prompt: string;                 // "Pick the cat"
  choices: Array<{
    label: string;                // human label ("Button 1")
    text?: string;                // button text
    imageBase64?: string;         // optional image on the button
  }>;
}

// Coordinates / grid / rotate / canvas / audio — image + hint payload.
export interface ImagePlusRequest extends SolveRequestBase {
  kind: "coordinates" | "grid" | "rotate" | "canvas" | "audio";
  imageBase64: string;
  hint?: string;
  extra?: Record<string, string | number | boolean>;
}

export type SolveRequest =
  | ImageSolveRequest
  | WebSolveRequest
  | MathSolveRequest
  | ButtonChoiceRequest
  | ImagePlusRequest;

export interface SolveResult {
  success: boolean;
  provider: string;              // "twocaptcha" | "ai-vision" | ...
  answer?: string;               // text answer / token
  choiceIndex?: number;          // buttonChoice
  latencyMs: number;
  costUsd?: number;
  error?: string;
}

export interface ProviderAdapter {
  id: CaptchaProvider;
  supports(kind: CaptchaKind): boolean;
  solve(apiKey: string, req: SolveRequest, opts: { signal?: AbortSignal }): Promise<SolveResult>;
  balance?(apiKey: string): Promise<number>;
}

export const KIND_LABELS: Record<CaptchaKind, string> = {
  image: "Image / text captcha",
  recaptchaV2: "reCAPTCHA v2",
  recaptchaV3: "reCAPTCHA v3",
  hcaptcha: "hCaptcha",
  turnstile: "Cloudflare Turnstile",
  math: "Math / word puzzle",
  buttonChoice: "Button-choice puzzle",
  geetest: "GeeTest v3",
  geetestV4: "GeeTest v4",
  funcaptcha: "FunCaptcha / Arkose",
  keycaptcha: "KeyCaptcha",
  capy: "Capy Puzzle",
  mtcaptcha: "MTCaptcha",
  friendlyCaptcha: "Friendly Captcha",
  amazonWaf: "Amazon WAF",
  datadome: "DataDome",
  lemin: "Lemin Cropped",
  cutcaptcha: "CutCaptcha",
  atbCaptcha: "AtbCAPTCHA",
  prosopo: "Prosopo Procaptcha",
  tencent: "Tencent Captcha",
  coordinates: "Click coordinates",
  grid: "Grid image puzzle",
  rotate: "Rotate image",
  canvas: "Canvas draw",
  audio: "Audio captcha",
};