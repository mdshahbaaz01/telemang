import type { ProviderAdapter, SolveRequest, SolveResult } from "../types";

const BASE = "https://api.anti-captcha.com";

async function createTask(apiKey: string, task: Record<string, unknown>): Promise<number> {
  const r = await fetch(`${BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task, softId: 0 }),
  });
  const j = (await r.json()) as { errorId?: number; taskId?: number; errorDescription?: string };
  if (j.errorId && j.errorId !== 0) throw new Error(`anticaptcha: ${j.errorDescription ?? "createTask failed"}`);
  if (!j.taskId) throw new Error("anticaptcha: no taskId");
  return j.taskId;
}

async function pollTask(apiKey: string, taskId: number, opts: { signal?: AbortSignal }): Promise<{ answer: string; cost?: number }> {
  const started = Date.now();
  const timeoutMs = 180_000;
  await new Promise((r) => setTimeout(r, 5_000));
  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const r = await fetch(`${BASE}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: opts.signal,
    });
    const j = (await r.json()) as {
      errorId?: number;
      status?: string;
      solution?: { text?: string; gRecaptchaResponse?: string; token?: string };
      cost?: string;
      errorDescription?: string;
    };
    if (j.errorId && j.errorId !== 0) throw new Error(`anticaptcha: ${j.errorDescription}`);
    if (j.status === "ready") {
      const answer = j.solution?.gRecaptchaResponse ?? j.solution?.token ?? j.solution?.text ?? "";
      return { answer, cost: j.cost ? Number(j.cost) : undefined };
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error("anticaptcha: timeout");
}

export const antiCaptchaAdapter: ProviderAdapter = {
  id: "anticaptcha",
  supports(kind) {
    return kind === "image" || kind === "recaptchaV2" || kind === "recaptchaV3" || kind === "hcaptcha" || kind === "turnstile";
  },
  async balance(apiKey) {
    const r = await fetch(`${BASE}/getBalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey }),
    });
    const j = (await r.json()) as { balance?: number; errorDescription?: string };
    if (j.balance === undefined) throw new Error(`anticaptcha balance: ${j.errorDescription ?? "unknown"}`);
    return j.balance;
  },
  async solve(apiKey, req, opts): Promise<SolveResult> {
    const t0 = Date.now();
    let task: Record<string, unknown>;
    if (req.kind === "image") {
      task = {
        type: "ImageToTextTask",
        body: req.imageBase64,
        numeric: req.numeric ? 1 : 0,
        minLength: req.minLength ?? 0,
        maxLength: req.maxLength ?? 0,
        case: !!req.caseSensitive,
        comment: req.hint ?? "",
      };
    } else if (req.kind === "recaptchaV2") {
      task = {
        type: "RecaptchaV2TaskProxyless",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
        isInvisible: !!req.invisible,
      };
    } else if (req.kind === "recaptchaV3") {
      task = {
        type: "RecaptchaV3TaskProxyless",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
        minScore: req.minScore ?? 0.3,
        pageAction: req.action ?? "verify",
      };
    } else if (req.kind === "hcaptcha") {
      task = {
        type: "HCaptchaTaskProxyless",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
      };
    } else if (req.kind === "turnstile") {
      task = {
        type: "TurnstileTaskProxyless",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
        action: req.action_turnstile,
        cData: req.data,
      };
    } else {
      throw new Error(`anticaptcha: unsupported kind ${(req as SolveRequest).kind}`);
    }
    const taskId = await createTask(apiKey, task);
    const { answer, cost } = await pollTask(apiKey, taskId, opts);
    return { success: true, provider: "anticaptcha", answer, latencyMs: Date.now() - t0, costUsd: cost };
  },
};