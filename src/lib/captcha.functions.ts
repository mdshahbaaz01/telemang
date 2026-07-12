import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ---------- Solver CRUD ----------

export const listSolvers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("captcha_solvers")
      .select("id, provider, label, enabled, priority, settings, balance_cached, balance_checked_at, created_at, updated_at")
      .order("priority", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const saveSolver = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      provider: z.enum(["twocaptcha", "anticaptcha", "capsolver"]),
      label: z.string().max(60).default(""),
      apiKey: z.string().min(8).max(500).optional(),
      enabled: z.boolean().default(true),
      priority: z.number().int().min(1).max(9999).default(100),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { encryptString } = await import("@/lib/crypto.server");
    if (data.id) {
      const patch: {
        label: string;
        enabled: boolean;
        priority: number;
        api_key_encrypted?: string;
      } = {
        label: data.label,
        enabled: data.enabled,
        priority: data.priority,
      };
      if (data.apiKey) patch.api_key_encrypted = await encryptString(data.apiKey);
      const { error } = await context.supabase
        .from("captcha_solvers")
        .update(patch)
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    if (!data.apiKey) throw new Error("API key required for new solver");
    const enc = await encryptString(data.apiKey);
    const { data: row, error } = await context.supabase
      .from("captcha_solvers")
      .insert({
        user_id: context.userId,
        provider: data.provider,
        label: data.label,
        api_key_encrypted: enc,
        enabled: data.enabled,
        priority: data.priority,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "insert failed");
    return { id: row.id as string };
  });

export const deleteSolver = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("captcha_solvers")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const refreshSolverBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { decryptString } = await import("@/lib/crypto.server");
    const { checkProviderBalance } = await import("@/lib/captcha/dispatcher.server");
    const { data: row, error } = await context.supabase
      .from("captcha_solvers")
      .select("id, provider, api_key_encrypted")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .single();
    if (error || !row) throw new Error(error?.message ?? "not found");
    const key = await decryptString(row.api_key_encrypted as string);
    const balance = await checkProviderBalance(row.provider as "twocaptcha" | "anticaptcha" | "capsolver", key);
    await context.supabase
      .from("captcha_solvers")
      .update({ balance_cached: balance, balance_checked_at: new Date().toISOString() })
      .eq("id", data.id);
    return { balance };
  });

// ---------- Solve ----------

const solveInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    imageBase64: z.string().min(20).max(4_000_000),
    hint: z.string().max(200).optional(),
    numeric: z.boolean().optional(),
    minLength: z.number().int().min(0).max(50).optional(),
    maxLength: z.number().int().min(0).max(50).optional(),
    caseSensitive: z.boolean().optional(),
    accountId: z.string().uuid().nullish(),
  }),
  z.object({
    kind: z.literal("math"),
    text: z.string().max(500).optional(),
    imageBase64: z.string().max(4_000_000).optional(),
    accountId: z.string().uuid().nullish(),
  }),
  z.object({
    kind: z.literal("buttonChoice"),
    prompt: z.string().min(1).max(300),
    choices: z.array(
      z.object({
        label: z.string().max(60),
        text: z.string().max(200).optional(),
        imageBase64: z.string().max(4_000_000).optional(),
      }),
    ).min(2).max(12),
    accountId: z.string().uuid().nullish(),
  }),
  z.object({
    kind: z.literal("recaptchaV2"),
    sitekey: z.string().min(4).max(200),
    pageUrl: z.string().url(),
    invisible: z.boolean().optional(),
    accountId: z.string().uuid().nullish(),
  }),
  z.object({
    kind: z.literal("recaptchaV3"),
    sitekey: z.string().min(4).max(200),
    pageUrl: z.string().url(),
    action: z.string().max(80).optional(),
    minScore: z.number().min(0).max(1).optional(),
    accountId: z.string().uuid().nullish(),
  }),
  z.object({
    kind: z.literal("hcaptcha"),
    sitekey: z.string().min(4).max(200),
    pageUrl: z.string().url(),
    accountId: z.string().uuid().nullish(),
  }),
  z.object({
    kind: z.literal("turnstile"),
    sitekey: z.string().min(4).max(200),
    pageUrl: z.string().url(),
    data: z.string().max(500).optional(),
    action_turnstile: z.string().max(80).optional(),
    accountId: z.string().uuid().nullish(),
  }),
]);

export const solveCaptcha = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => solveInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { dispatchSolve, loadUserSolvers } = await import("@/lib/captcha/dispatcher.server");
    const solvers = await loadUserSolvers(context.supabase, context.userId);
    const started = Date.now();
    let logRow: {
      provider: string;
      kind: string;
      success: boolean;
      latency_ms: number;
      answer_preview: string | null;
      error: string | null;
      cost_usd: number | null;
    };
    try {
      const res = await dispatchSolve(data, solvers);
      logRow = {
        provider: res.provider,
        kind: data.kind,
        success: res.success,
        latency_ms: res.latencyMs || Date.now() - started,
        answer_preview: res.answer ? res.answer.slice(0, 80) : null,
        error: res.error ?? null,
        cost_usd: res.costUsd ?? null,
      };
      await context.supabase.from("captcha_solve_log").insert({
        user_id: context.userId,
        account_id: data.accountId ?? null,
        context: { pageUrl: (data as { pageUrl?: string }).pageUrl ?? null },
        ...logRow,
      });
      return res;
    } catch (e) {
      const err = (e as Error).message;
      await context.supabase.from("captcha_solve_log").insert({
        user_id: context.userId,
        account_id: data.accountId ?? null,
        provider: "error",
        kind: data.kind,
        success: false,
        latency_ms: Date.now() - started,
        error: err,
      });
      throw e;
    }
  });

// ---------- Log ----------

export const listSolveLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("captcha_solve_log")
      .select("id, provider, kind, success, latency_ms, cost_usd, answer_preview, error, account_id, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const clearSolveLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("captcha_solve_log")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });