import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runWithLimit } from "./p-limit";

function parseRefLink(link: string): { botUsername: string; startParam: string | null } | null {
  try {
    const u = new URL(link);
    if (!/^t\.me$/i.test(u.hostname) && !/telegram\.me$/i.test(u.hostname)) return null;
    const path = u.pathname.replace(/^\//, "");
    if (!path) return null;
    const bot = path.split("/")[0];
    const start = u.searchParams.get("start") || u.searchParams.get("startapp") || null;
    return { botUsername: bot, startParam: start };
  } catch { return null; }
}

export const listReferralLinks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("referral_links").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

// Aggregate joins grouped by bot username. For each bot: total links,
// total joined accounts, error count, and the list of joined accounts
// (with human-readable names) so the user can see which IDs referred.
export const summarizeReferralsByBot = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [linksRes, joinsRes, accsRes] = await Promise.all([
      context.supabase.from("referral_links").select("id, bot_username, my_ref_code, note"),
      context.supabase.from("referral_joins").select("account_id, status, joined_at, referral_link_id, last_balance_numeric, last_balance_text"),
      context.supabase.from("telegram_accounts").select("id, first_name, username, phone"),
    ]);
    if (linksRes.error) throw linksRes.error;
    if (joinsRes.error) throw joinsRes.error;

    const nameFor = new Map<string, string>();
    for (const a of accsRes.data ?? []) {
      nameFor.set(a.id as string, (a.first_name || a.username || a.phone || (a.id as string).slice(0, 6)) as string);
    }
    const linkById = new Map<string, { bot_username: string; my_ref_code: string | null; note: string | null }>();
    for (const l of linksRes.data ?? []) linkById.set(l.id as string, l as any);

    type BotRow = {
      bot_username: string;
      links: number;
      joined: number;
      errors: number;
      pending: number;
      totalBalance: number;
      accounts: Array<{
        account_id: string;
        name: string;
        status: string;
        joined_at: string | null;
        ref_code: string | null;
        note: string | null;
        balance_numeric: number | null;
        balance_text: string | null;
      }>;
    };
    const map = new Map<string, BotRow>();

    // Ensure every bot with a link appears even if it has 0 joins
    for (const l of linksRes.data ?? []) {
      const bot = String(l.bot_username);
      const cur = map.get(bot) ?? { bot_username: bot, links: 0, joined: 0, errors: 0, pending: 0, totalBalance: 0, accounts: [] };
      cur.links += 1;
      map.set(bot, cur);
    }

    for (const j of joinsRes.data ?? []) {
      const link = linkById.get(j.referral_link_id as string);
      if (!link) continue;
      const cur = map.get(link.bot_username) ?? { bot_username: link.bot_username, links: 0, joined: 0, errors: 0, pending: 0, totalBalance: 0, accounts: [] };
      const status = String(j.status ?? "pending");
      if (status === "joined") cur.joined += 1;
      else if (status === "error") cur.errors += 1;
      else cur.pending += 1;
      if (typeof j.last_balance_numeric === "number") cur.totalBalance += j.last_balance_numeric;
      cur.accounts.push({
        account_id: j.account_id as string,
        name: nameFor.get(j.account_id as string) ?? String(j.account_id).slice(0, 6),
        status,
        joined_at: (j.joined_at as string) ?? null,
        ref_code: link.my_ref_code,
        note: link.note,
        balance_numeric: (j.last_balance_numeric as number) ?? null,
        balance_text: (j.last_balance_text as string) ?? null,
      });
      map.set(link.bot_username, cur);
    }

    return [...map.values()].sort((a, b) => b.joined - a.joined);
  });

export const upsertReferralLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      link: z.string().url().max(500),
      note: z.string().max(200).optional().nullable(),
      balance_field: z.string().max(64).optional().nullable(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const parsed = parseRefLink(data.link);
    if (!parsed) throw new Error("Invalid t.me link");
    const payload = {
      user_id: context.userId,
      bot_username: parsed.botUsername,
      base_link: data.link,
      my_ref_code: parsed.startParam,
      note: data.note ?? null,
      balance_field: data.balance_field ?? null,
    };
    const q = data.id
      ? context.supabase.from("referral_links").update(payload).eq("id", data.id).select().single()
      : context.supabase.from("referral_links").insert(payload).select().single();
    const { data: row, error } = await q;
    if (error) throw error;
    return row;
  });

export const deleteReferralLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("referral_links").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const listReferralJoins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_link_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("referral_joins").select("*").eq("referral_link_id", data.referral_link_id)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return rows ?? [];
  });

// Run /start with the ref code from N accounts, storing status per account.
export const joinReferralFromAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      referral_link_id: z.string().uuid(),
      accountIds: z.array(z.string().uuid()).min(1).max(100),
      concurrency: z.number().int().min(1).max(10).default(3),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const { default: bigInt } = await import("big-integer");

    const { data: link, error: lErr } = await context.supabase
      .from("referral_links").select("*").eq("id", data.referral_link_id).single();
    if (lErr || !link) throw new Error("Referral link not found");

    const results: Array<{ accountId: string; ok: boolean; message: string }> = [];

    await runWithLimit(data.accountIds, data.concurrency, async (accountId) => {
      let client;
      try { client = await openClientForAccount(context.supabase, accountId, { requireOwnerId: context.userId }); }
      catch (e) {
        results.push({ accountId, ok: false, message: `Connect: ${(e as Error).message}` });
        await context.supabase.from("referral_joins").upsert({
          user_id: context.userId, referral_link_id: link.id, account_id: accountId,
          status: "error", last_error: `Connect: ${(e as Error).message}`,
        }, { onConflict: "referral_link_id,account_id" });
        return;
      }
      try {
        const bot: any = await client.getEntity(link.bot_username);
        if (link.my_ref_code) {
          await client.invoke(new Api.messages.StartBot({
            bot, peer: bot, startParam: link.my_ref_code,
            randomId: bigInt(Math.floor(Math.random() * 1e18)),
          }));
        } else {
          await client.sendMessage(bot, { message: "/start" });
        }
        await context.supabase.from("referral_joins").upsert({
          user_id: context.userId, referral_link_id: link.id, account_id: accountId,
          joined_at: new Date().toISOString(), status: "joined", last_error: null,
        }, { onConflict: "referral_link_id,account_id" });
        results.push({ accountId, ok: true, message: "Joined" });
      } catch (e) {
        const em = (e as Error).message;
        await context.supabase.from("referral_joins").upsert({
          user_id: context.userId, referral_link_id: link.id, account_id: accountId,
          status: "error", last_error: em,
        }, { onConflict: "referral_link_id,account_id" });
        results.push({ accountId, ok: false, message: em });
      } finally { await client.disconnect().catch(() => {}); }
    });

    return { results };
  });

// Pull latest balance for each joined account by reading the newest matching
// bot_parse_results row for this link's balance_field.
export const refreshReferralBalances = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_link_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: link } = await context.supabase
      .from("referral_links").select("*").eq("id", data.referral_link_id).single();
    if (!link) throw new Error("Referral link not found");
    if (!link.balance_field) return { updated: 0, note: "No balance_field set on this link — set one and run Bot Parser scan first." };

    const { data: joins } = await context.supabase
      .from("referral_joins").select("id, account_id").eq("referral_link_id", link.id);
    if (!joins?.length) return { updated: 0 };

    let updated = 0;
    for (const j of joins) {
      const { data: latest } = await context.supabase
        .from("bot_parse_results")
        .select("value_numeric, value_text, captured_at")
        .eq("account_id", j.account_id)
        .eq("field_name", link.balance_field)
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest) {
        await context.supabase.from("referral_joins").update({
          last_balance_numeric: latest.value_numeric,
          last_balance_text: latest.value_text,
          last_checked_at: new Date().toISOString(),
        }).eq("id", j.id);
        updated++;
      }
    }
    return { updated };
  });

// ---------------------------------------------------------------------------
// Bot Flow history — surfaces past botflow runs so the Referrals page can list
// which accounts ran which bot/link, and jump into each account's bot chat.
// ---------------------------------------------------------------------------

function parseBotFromParams(params: any): { bot: string; startParam: string | null; link: string | null } {
  const op = params?.op ?? {};
  const raw = String(op?.bot ?? "").trim();
  let bot = raw;
  let startParam: string | null = op?.startParam ?? null;
  let link: string | null = null;
  try {
    if (/^https?:\/\//i.test(raw) || /^t\.me\//i.test(raw)) {
      const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      link = u.toString();
      bot = u.pathname.replace(/^\//, "").split("/")[0];
      startParam = startParam ?? u.searchParams.get("start") ?? u.searchParams.get("startapp");
    }
  } catch { /* ignore */ }
  return { bot: bot.replace(/^@/, ""), startParam, link };
}

export const listBotFlowHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: runs, error } = await context.supabase
      .from("action_runs")
      .select("id, kind, status, params, created_at, updated_at")
      .eq("kind", "botflow")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const { data: accs } = await context.supabase
      .from("telegram_accounts").select("id, first_name, username, phone");
    const nameFor = new Map<string, string>();
    for (const a of accs ?? []) {
      nameFor.set(a.id as string, (a.first_name || a.username || a.phone || (a.id as string).slice(0, 6)) as string);
    }

    return (runs ?? []).map((r: any) => {
      const info = parseBotFromParams(r.params);
      const accountIds: string[] = Array.isArray(r.params?.accountIds) ? r.params.accountIds : [];
      const steps: string[] = Array.isArray(r.params?.op?.steps) ? r.params.op.steps : [];
      return {
        id: r.id as string,
        status: r.status as string,
        created_at: r.created_at as string,
        bot: info.bot,
        startParam: info.startParam,
        link: info.link,
        steps,
        accounts: accountIds.map((id) => ({
          account_id: id,
          name: nameFor.get(id) ?? id.slice(0, 6),
        })),
      };
    });
  });

export const listBotFlowRunLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ run_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("action_logs")
      .select("account_id, target, level, message, created_at")
      .eq("run_id", data.run_id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return rows ?? [];
  });