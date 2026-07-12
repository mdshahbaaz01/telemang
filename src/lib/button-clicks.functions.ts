import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const clickSchema = z.object({
  runId: z.string().uuid().nullish(),
  accountId: z.string().uuid().nullish(),
  peerKey: z.string().max(200).nullish(),
  target: z.string().max(200).nullish(),
  msgId: z.number().int().nullish(),
  buttonKind: z.string().min(1).max(32),
  buttonLabel: z.string().max(300).nullish(),
  buttonPayload: z.string().max(1000).nullish(),
  source: z.enum(["viewer", "broadcast", "botflow", "referrals", "other"]).default("viewer"),
  resultStatus: z.enum(["ok", "error", "opened"]).default("ok"),
  resultMessage: z.string().max(2000).nullish(),
  resultAlert: z.boolean().default(false),
  resultUrl: z.string().max(2000).nullish(),
});

export const recordInlineButtonClick = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => clickSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("inline_button_clicks").insert({
      user_id: context.userId,
      run_id: data.runId ?? null,
      account_id: data.accountId ?? null,
      peer_key: data.peerKey ?? null,
      target: data.target ?? null,
      msg_id: data.msgId ?? null,
      button_kind: data.buttonKind,
      button_label: data.buttonLabel ?? null,
      button_payload: data.buttonPayload ?? null,
      source: data.source,
      result_status: data.resultStatus,
      result_message: data.resultMessage ?? null,
      result_alert: data.resultAlert,
      result_url: data.resultUrl ?? null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listInlineButtonClicks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        runId: z.string().uuid().nullish(),
        accountId: z.string().uuid().nullish(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("inline_button_clicks")
      .select(
        "id, run_id, account_id, peer_key, target, msg_id, button_kind, button_label, source, result_status, result_message, result_alert, result_url, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.runId) q = q.eq("run_id", data.runId);
    if (data.accountId) q = q.eq("account_id", data.accountId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// Server-side helper (call inside other server fns after button executions)
export async function insertInlineButtonClick(
  supabase: any,
  userId: string,
  row: {
    runId?: string | null;
    accountId?: string | null;
    peerKey?: string | null;
    target?: string | null;
    msgId?: number | null;
    buttonKind: string;
    buttonLabel?: string | null;
    buttonPayload?: string | null;
    source: "viewer" | "broadcast" | "botflow" | "referrals" | "other";
    resultStatus?: "ok" | "error" | "opened";
    resultMessage?: string | null;
    resultAlert?: boolean;
    resultUrl?: string | null;
  },
) {
  try {
    await supabase.from("inline_button_clicks").insert({
      user_id: userId,
      run_id: row.runId ?? null,
      account_id: row.accountId ?? null,
      peer_key: row.peerKey ?? null,
      target: row.target ?? null,
      msg_id: row.msgId ?? null,
      button_kind: row.buttonKind,
      button_label: row.buttonLabel ?? null,
      button_payload: row.buttonPayload ?? null,
      source: row.source,
      result_status: row.resultStatus ?? "ok",
      result_message: row.resultMessage ?? null,
      result_alert: !!row.resultAlert,
      result_url: row.resultUrl ?? null,
    });
  } catch {
    /* logging failures shouldn't break the click flow */
  }
}