import type { ProviderAdapter, SolveRequest, SolveResult } from "../types";

const IN = "https://2captcha.com/in.php";
const RES = "https://2captcha.com/res.php";

async function pollResult(apiKey: string, requestId: string, opts: { signal?: AbortSignal }): Promise<string> {
  const started = Date.now();
  const timeoutMs = 180_000;
  // 2Captcha needs ~15s warmup for image, 20s for recaptcha
  await new Promise((r) => setTimeout(r, 8_000));
  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const url = `${RES}?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(requestId)}&json=1`;
    const r = await fetch(url, { signal: opts.signal });
    const j = (await r.json()) as { status?: number; request?: string; error_text?: string };
    if (j.status === 1 && j.request) return j.request;
    if (j.request && j.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2captcha: ${j.request}${j.error_text ? ` (${j.error_text})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 3_500));
  }
  throw new Error("2captcha: timeout waiting for answer");
}

async function submit(apiKey: string, body: Record<string, string | number | boolean>): Promise<string> {
  const form = new URLSearchParams();
  form.set("key", apiKey);
  form.set("json", "1");
  for (const [k, v] of Object.entries(body)) form.set(k, String(v));
  const r = await fetch(IN, { method: "POST", body: form });
  const j = (await r.json()) as { status?: number; request?: string; error_text?: string };
  if (j.status !== 1 || !j.request) {
    throw new Error(`2captcha submit failed: ${j.request ?? "unknown"}${j.error_text ? ` (${j.error_text})` : ""}`);
  }
  return j.request;
}

export const twoCaptchaAdapter: ProviderAdapter = {
  id: "twocaptcha",
  supports(kind) {
    // 2Captcha supports ~everything.
    return kind !== "math" && kind !== "buttonChoice";
  },
  async balance(apiKey) {
    const r = await fetch(`${RES}?key=${encodeURIComponent(apiKey)}&action=getbalance&json=1`);
    const j = (await r.json()) as { status?: number; request?: string };
    if (j.status !== 1) throw new Error(`2captcha balance: ${j.request}`);
    return Number(j.request);
  },
  async solve(apiKey, req, opts): Promise<SolveResult> {
    const t0 = Date.now();
    let requestId: string;
    if (req.kind === "image") {
      requestId = await submit(apiKey, {
        method: "base64",
        body: req.imageBase64,
        numeric: req.numeric ? 1 : 0,
        min_len: req.minLength ?? 0,
        max_len: req.maxLength ?? 0,
        regsense: req.caseSensitive ? 1 : 0,
        textinstructions: req.hint ?? "",
      });
    } else if (req.kind === "recaptchaV2") {
      requestId = await submit(apiKey, {
        method: "userrecaptcha",
        googlekey: req.sitekey,
        pageurl: req.pageUrl,
        invisible: req.invisible ? 1 : 0,
      });
    } else if (req.kind === "recaptchaV3") {
      requestId = await submit(apiKey, {
        method: "userrecaptcha",
        version: "v3",
        googlekey: req.sitekey,
        pageurl: req.pageUrl,
        action: req.action ?? "verify",
        min_score: req.minScore ?? 0.3,
      });
    } else if (req.kind === "hcaptcha") {
      requestId = await submit(apiKey, { method: "hcaptcha", sitekey: req.sitekey, pageurl: req.pageUrl });
    } else if (req.kind === "turnstile") {
      const body: Record<string, string | number | boolean> = {
        method: "turnstile",
        sitekey: req.sitekey,
        pageurl: req.pageUrl,
      };
      if (req.data) body.data = req.data;
      if (req.action_turnstile) body.action = req.action_turnstile;
      requestId = await submit(apiKey, body);
    } else if (
      req.kind === "geetest" || req.kind === "geetestV4" || req.kind === "funcaptcha" ||
      req.kind === "keycaptcha" || req.kind === "capy" || req.kind === "mtcaptcha" ||
      req.kind === "friendlyCaptcha" || req.kind === "amazonWaf" || req.kind === "datadome" ||
      req.kind === "lemin" || req.kind === "cutcaptcha" || req.kind === "atbCaptcha" ||
      req.kind === "prosopo" || req.kind === "tencent"
    ) {
      const methodMap: Record<string, string> = {
        geetest: "geetest",
        geetestV4: "geetest_v4",
        funcaptcha: "funcaptcha",
        keycaptcha: "keycaptcha",
        capy: "capy",
        mtcaptcha: "mt_captcha",
        friendlyCaptcha: "friendly_captcha",
        amazonWaf: "amazon_waf",
        datadome: "datadome",
        lemin: "lemin",
        cutcaptcha: "cutcaptcha",
        atbCaptcha: "atb_captcha",
        prosopo: "prosopo",
        tencent: "tencent",
      };
      const body: Record<string, string | number | boolean> = {
        method: methodMap[req.kind],
        sitekey: req.sitekey,
        pageurl: req.pageUrl,
        ...(req.extra ?? {}),
      };
      requestId = await submit(apiKey, body);
    } else if (
      req.kind === "coordinates" || req.kind === "grid" || req.kind === "canvas" ||
      req.kind === "rotate" || req.kind === "audio"
    ) {
      const methodMap: Record<string, string> = {
        coordinates: "base64",
        grid: "base64",
        canvas: "base64",
        rotate: "rotatecaptcha",
        audio: "audio",
      };
      const body: Record<string, string | number | boolean> = {
        method: methodMap[req.kind],
        body: req.imageBase64,
        textinstructions: req.hint ?? "",
        ...(req.kind === "coordinates" ? { coordinatescaptcha: 1 } : {}),
        ...(req.kind === "grid" ? { recaptcha: 1 } : {}),
        ...(req.kind === "canvas" ? { canvas: 1 } : {}),
        ...(req.extra ?? {}),
      };
      requestId = await submit(apiKey, body);
    } else {
      throw new Error(`2captcha: unsupported kind ${(req as SolveRequest).kind}`);
    }
    const answer = await pollResult(apiKey, requestId, opts);
    return { success: true, provider: "twocaptcha", answer, latencyMs: Date.now() - t0 };
  },
};