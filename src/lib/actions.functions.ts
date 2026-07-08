import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any, userId: string) {
  const { data: roles } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (!(roles ?? []).some((r: { role: string }) => r.role === "admin")) {
    throw new Error("Forbidden");
  }
}

export const listActionRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("action_runs")
      .select("id, kind, status, params, totals, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getActionLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ runId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase
      .from("action_logs")
      .select("id, account_id, target, level, message, created_at")
      .eq("run_id", data.runId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const stopActionRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ runId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("action_runs")
      .update({ status: "stopped", updated_at: new Date().toISOString() })
      .eq("id", data.runId)
      .eq("status", "running");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteActionRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ runId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    await context.supabase.from("action_logs").delete().eq("run_id", data.runId);
    const { error } = await context.supabase
      .from("action_runs")
      .delete()
      .eq("id", data.runId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const clearActionRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    await context.supabase.from("action_logs").delete().not("run_id", "is", null);
    const { error } = await context.supabase
      .from("action_runs")
      .delete()
      .not("id", "is", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const loadPollSchema = z.object({
  chat: z.string().min(1),
  msgId: z.number().int().positive(),
  accountId: z.string().uuid().optional(),
});

export const loadPoll = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => loadPollSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { openClientForAccount } = await import("./cleanup.server");

    let accountId = data.accountId;
    if (!accountId) {
      const { data: acct, error } = await context.supabase
        .from("telegram_accounts")
        .select("id")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!acct) throw new Error("No active accounts available");
      accountId = acct.id;
    }

    const client = await openClientForAccount(context.supabase, accountId);
    try {
      let peer: any;
      const resolveEntity = async (target: any) => {
        try {
          return await client.getEntity(target);
        } catch (e) {
          const msg = (e as Error).message || "";
          if (!/Could not find the input entity/i.test(msg)) throw e;
          // Warm the entity cache by iterating dialogs, then retry once.
          for await (const _ of client.iterDialogs({ limit: 200 })) {
            void _;
          }
          return await client.getEntity(target);
        }
      };
      if (data.chat.startsWith("c/")) {
        const raw = data.chat.slice(2);
        const { default: bigInt } = await import("big-integer");
        const { Api } = await import("telegram");
        try {
          peer = await resolveEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
        } catch (e) {
          throw new Error(
            `Account can't access this private chat (t.me/c/${raw}). The account must be a member of the group/channel first. Original: ${(e as Error).message}`,
          );
        }
      } else {
        peer = await resolveEntity(data.chat.replace(/^@/, ""));
      }
      const [msg] = await client.getMessages(peer, { ids: [data.msgId] });
      if (!msg?.poll) throw new Error("Message is not a poll");
      const media = msg.poll as {
        poll?: {
          question?: { text?: string } | string;
          answers?: Array<{ text?: { text?: string } | string; option?: Uint8Array }>;
          multipleChoice?: boolean;
          closed?: boolean;
          publicVoters?: boolean;
        };
        results?: {
          results?: Array<{ option?: Uint8Array; voters?: number; chosen?: boolean; correct?: boolean }>;
          totalVoters?: number;
        };
      };
      const p = media.poll ?? {};
      const r = media.results ?? {};
      const q = typeof p.question === "string" ? p.question : p.question?.text ?? "";
      const rawAnswers = p.answers ?? [];
      const rawResults = r.results ?? [];
      const bufEq = (a?: Uint8Array, b?: Uint8Array) => {
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      };
      const answers = rawAnswers.map((a, i) => {
        const text = typeof a.text === "string" ? a.text : a.text?.text ?? "";
        const match = rawResults.find((rr) => bufEq(rr.option, a.option)) ?? rawResults[i];
        return {
          text,
          voters: Number(match?.voters ?? 0),
          chosen: !!match?.chosen,
        };
      });
      const chosenAny = answers.some((a) => a.chosen);
      return {
        question: q,
        answers,
        multipleChoice: !!p.multipleChoice,
        closed: !!p.closed,
        totalVoters: Number(r.totalVoters ?? 0),
        alreadyVoted: chosenAny,
        checkedAccountId: accountId,
      };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

export const getReferralStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("action_runs")
      .select("id, status, totals, params, created_at")
      .eq("kind", "botflow")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const stats = new Map<string, { code: string; runs: number; ok: number; fail: number; lastRun: string | null }>();
    for (const run of data ?? []) {
      const op = (run.params as any)?.op ?? {};
      const link = String(op.bot ?? "");
      let code = String(op.startParam ?? "");
      if (!code && link) {
        try {
          const url = new URL(link.startsWith("http") ? link : `https://${link}`);
          code = url.searchParams.get("start") || url.searchParams.get("startapp") || "no-code";
        } catch {
          code = "no-code";
        }
      }
      if (!code) code = "no-code";
      const existing = stats.get(code) ?? { code, runs: 0, ok: 0, fail: 0, lastRun: null };
      existing.runs += 1;
      existing.ok += Number((run.totals as any)?.ok ?? 0);
      existing.fail += Number((run.totals as any)?.fail ?? 0);
      existing.lastRun = existing.lastRun ?? (run.created_at as string);
      stats.set(code, existing);
    }
    return Array.from(stats.values()).sort((a, b) => b.runs - a.runs);
  });

const notificationSettingsSchema = z.object({
  emailEnabled: z.boolean(),
  telegramEnabled: z.boolean(),
  emailTo: z.string().email().or(z.literal("")).optional(),
  telegramChat: z.string().max(200).optional(),
  alertSuccess: z.boolean(),
  alertFailure: z.boolean(),
  alertAccount: z.boolean(),
});

export const getNotificationSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("notification_settings")
      .select("email_enabled, telegram_enabled, email_to, telegram_chat, alert_success, alert_failure, alert_account")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      emailEnabled: !!data?.email_enabled,
      telegramEnabled: !!data?.telegram_enabled,
      emailTo: data?.email_to ?? "",
      telegramChat: data?.telegram_chat ?? "",
      alertSuccess: data?.alert_success ?? true,
      alertFailure: data?.alert_failure ?? true,
      alertAccount: data?.alert_account ?? true,
    };
  });

export const saveNotificationSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => notificationSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.from("notification_settings").upsert({
      user_id: context.userId,
      email_enabled: data.emailEnabled,
      telegram_enabled: data.telegramEnabled,
      email_to: data.emailTo || null,
      telegram_chat: data.telegramChat || null,
      alert_success: data.alertSuccess,
      alert_failure: data.alertFailure,
      alert_account: data.alertAccount,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listNotificationLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("notification_logs")
      .select("id, channel, event, title, body, status, error, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });