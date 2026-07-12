import { decryptString } from "@/lib/crypto.server";
import type { CaptchaProvider, ProviderAdapter, SolveRequest, SolveResult } from "./types";
import { twoCaptchaAdapter } from "./providers/twocaptcha.server";
import { antiCaptchaAdapter } from "./providers/anticaptcha.server";
import { capSolverAdapter } from "./providers/capsolver.server";
import {
  solveButtonChoiceAi,
  solveImageAi,
  solveMathAi,
  solveGridAi,
  solveCoordinatesAi,
  solveRotateAi,
  solveAudioAi,
} from "./ai-vision.server";

export const ADAPTERS: Record<CaptchaProvider, ProviderAdapter> = {
  twocaptcha: twoCaptchaAdapter,
  anticaptcha: antiCaptchaAdapter,
  capsolver: capSolverAdapter,
};

export interface StoredSolverRow {
  id: string;
  provider: CaptchaProvider;
  label: string;
  api_key_encrypted: string;
  enabled: boolean;
  priority: number;
}

export async function loadUserSolvers(supabase: unknown, userId: string): Promise<StoredSolverRow[]> {
  const { data, error } = await (supabase as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: boolean) => {
            order: (c: string, o: { ascending: boolean }) => Promise<{ data: StoredSolverRow[] | null; error: unknown }>;
          };
        };
      };
    };
  })
    .from("captcha_solvers")
    .select("id, provider, label, api_key_encrypted, enabled, priority")
    .eq("user_id", userId)
    .eq("enabled", true)
    .order("priority", { ascending: true });
  if (error) throw new Error((error as Error).message ?? "load solvers failed");
  return data ?? [];
}

/**
 * Dispatch a solve request. Strategy:
 *   - math + buttonChoice → always Lovable AI (no external solver supports them well).
 *   - image → try external solvers in priority order; on total failure, AI vision.
 *   - web challenges (recaptcha/hcaptcha/turnstile) → external solvers only.
 */
export async function dispatchSolve(
  req: SolveRequest,
  solvers: StoredSolverRow[],
  opts: { signal?: AbortSignal } = {},
): Promise<SolveResult> {
  const errors: string[] = [];

  if (req.kind === "math") return solveMathAi(req);
  if (req.kind === "buttonChoice") return solveButtonChoiceAi(req);
  // Native AI visual solvers — no external key needed.
  if (req.kind === "grid") return solveGridAi(req);
  if (req.kind === "coordinates") return solveCoordinatesAi(req);
  if (req.kind === "rotate") return solveRotateAi(req);
  if (req.kind === "audio") return solveAudioAi(req);

  const eligible = solvers.filter((s) => ADAPTERS[s.provider]?.supports(req.kind));

  for (const s of eligible) {
    const adapter = ADAPTERS[s.provider];
    try {
      const apiKey = await decryptString(s.api_key_encrypted);
      const res = await adapter.solve(apiKey, req, opts);
      if (res.success && res.answer) return { ...res, provider: `${s.provider}:${s.label || "default"}` };
      errors.push(`${s.provider}: no answer`);
    } catch (e) {
      errors.push(`${s.provider}: ${(e as Error).message}`);
    }
  }

  if (req.kind === "image" || req.kind === "canvas") {
    try {
      const res =
        req.kind === "image"
          ? await solveImageAi(req)
          : await solveCoordinatesAi(req); // canvas → treat as coordinate pick
      return res;
    } catch (e) {
      errors.push(`ai-vision: ${(e as Error).message}`);
    }
  }

  return {
    success: false,
    provider: "none",
    latencyMs: 0,
    error: errors.join(" | ") || "no eligible solver configured",
  };
}

export async function checkProviderBalance(provider: CaptchaProvider, apiKey: string): Promise<number> {
  const a = ADAPTERS[provider];
  if (!a?.balance) throw new Error(`${provider}: balance not supported`);
  return a.balance(apiKey);
}