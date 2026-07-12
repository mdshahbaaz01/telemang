import type { ProviderAdapter, SolveRequest, SolveResult } from "../types";

const BASE = "https://api.capsolver.com";

async function createTask(apiKey: string, task: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
  });
  const j = (await r.json()) as { errorId?: number; taskId?: string; errorDescription?: string };
  if (j.errorId && j.errorId !== 0) throw new Error(`capsolver: ${j.errorDescription}`);
  if (!j.taskId) throw new Error("capsolver: no taskId");
  return j.taskId;
}

async function pollTask(apiKey: string, taskId: string, opts: { signal?: AbortSignal }): Promise<{ answer: string }> {
  const started = Date.now();
  const timeoutMs = 180_000;
  await new Promise((r) => setTimeout(r, 3_000));
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
      errorDescription?: string;
    };
    if (j.errorId && j.errorId !== 0) throw new Error(`capsolver: ${j.errorDescription}`);
    if (j.status === "ready") {
      const answer = j.solution?.gRecaptchaResponse ?? j.solution?.token ?? j.solution?.text ?? "";
      return { answer };
    }
    await new Promise((r) => setTimeout(r, 2_500));
  }
  throw new Error("capsolver: timeout");
}

export const capSolverAdapter: ProviderAdapter = {
  id: "capsolver",
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
    if (j.balance === undefined) throw new Error(`capsolver balance: ${j.errorDescription}`);
    return j.balance;
  },
  async solve(apiKey, req, opts): Promise<SolveResult> {
    const t0 = Date.now();
    let task: Record<string, unknown>;
    if (req.kind === "image") {
      task = {
        type: "ImageToTextTask",
        body: req.imageBase64,
        module: "common",
      };
    } else if (req.kind === "recaptchaV2") {
      task = {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
        isInvisible: !!req.invisible,
      };
    } else if (req.kind === "recaptchaV3") {
      task = {
        type: "ReCaptchaV3TaskProxyLess",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
        pageAction: req.action ?? "verify",
        minScore: req.minScore ?? 0.3,
      };
    } else if (req.kind === "hcaptcha") {
      task = {
        type: "HCaptchaTaskProxyLess",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
      };
    } else if (req.kind === "turnstile") {
      task = {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: req.pageUrl,
        websiteKey: req.sitekey,
        metadata: req.action_turnstile ? { action: req.action_turnstile, cdata: req.data } : undefined,
      };
    } else {
      throw new Error(`capsolver: unsupported kind ${(req as SolveRequest).kind}`);
    }
    const taskId = await createTask(apiKey, task);
    const { answer } = await pollTask(apiKey, taskId, opts);
    return { success: true, provider: "capsolver", answer, latencyMs: Date.now() - t0 };
  },
};