export type CaptchaProvider = "twocaptcha" | "anticaptcha" | "capsolver";

export type CaptchaKind =
  | "image"           // base64 image → text answer
  | "recaptchaV2"     // sitekey + pageUrl → g-recaptcha token
  | "recaptchaV3"     // sitekey + pageUrl + action + minScore → token
  | "hcaptcha"        // sitekey + pageUrl → h-captcha token
  | "turnstile"       // sitekey + pageUrl → cf-turnstile token
  | "math"            // AI vision/text: solve "3+7=?" → number
  | "buttonChoice";   // AI vision: pick which image button matches prompt

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
  kind: "recaptchaV2" | "recaptchaV3" | "hcaptcha" | "turnstile";
  sitekey: string;
  pageUrl: string;
  action?: string;      // recaptchaV3
  minScore?: number;    // recaptchaV3
  invisible?: boolean;  // recaptchaV2
  data?: string;        // turnstile cData
  action_turnstile?: string;
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

export type SolveRequest =
  | ImageSolveRequest
  | WebSolveRequest
  | MathSolveRequest
  | ButtonChoiceRequest;

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
};