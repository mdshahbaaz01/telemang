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
      if (data.chat.startsWith("c/")) {
        const raw = data.chat.slice(2);
        const { default: bigInt } = await import("big-integer");
        peer = await client.getEntity(bigInt(raw));
      } else {
        peer = await client.getEntity(data.chat.replace(/^@/, ""));
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