import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runWithLimit } from "./p-limit";

// --- ReDoS hardening ---------------------------------------------------------
// JavaScript regex is synchronous & single-threaded; a catastrophic-backtracking
// pattern can freeze the whole worker. We defend in depth:
//  1) Reject obviously dangerous constructs (nested quantifiers on groups).
//  2) Hard-cap pattern length.
//  3) Hard-cap the input string length before .match().
//  4) Wrap execution in a wall-clock budget and abort further rule evaluation
//     for that account if a single match exceeds it.
const MAX_PATTERN_LEN = 500;
const MAX_INPUT_LEN = 2000;
const MATCH_BUDGET_MS = 50;

const DANGEROUS_PATTERNS: RegExp[] = [
  /\([^)]*[+*][^)]*\)[+*]/,        // (a+)+ / (a*)* / (.+)+ style nested quantifiers
  /\([^)]*\{\d+,?\d*\}[^)]*\)[+*]/, // (a{2,})+ style
  /\([^)]+\|[^)]+\)[+*]/,           // (a|a)+ overlapping alternation
];

function assertSafeRegex(src: string): void {
  if (src.length > MAX_PATTERN_LEN) {
    throw new Error(`Regex too long (max ${MAX_PATTERN_LEN} chars)`);
  }
  for (const bad of DANGEROUS_PATTERNS) {
    if (bad.test(src)) {
      throw new Error("Regex rejected: potentially catastrophic backtracking pattern");
    }
  }
  try { new RegExp(src); } catch (e) { throw new Error(`Bad regex: ${(e as Error).message}`); }
}

function safeMatch(text: string, re: RegExp): RegExpMatchArray | null {
  const input = text.length > MAX_INPUT_LEN ? text.slice(0, MAX_INPUT_LEN) : text;
  const start = Date.now();
  const result = input.match(re);
  if (Date.now() - start > MATCH_BUDGET_MS) {
    // Signal so the caller can stop applying this rule further this run.
    throw new Error(`Regex exceeded ${MATCH_BUDGET_MS}ms budget`);
  }
  return result;
}

const ruleSchema = z.object({
  name: z.string().min(1).max(80),
  bot_username: z.string().min(1).max(64),
  regex: z.string().min(1).max(MAX_PATTERN_LEN),
  field_name: z.string().min(1).max(64),
  unit: z.string().max(20).optional().nullable(),
  classification: z.enum(["success", "warning", "error", "info"]).optional().nullable(),
});

export const listParseRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("bot_parse_rules")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

export const upsertParseRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid().optional(), rule: ruleSchema }).parse(d))
  .handler(async ({ data, context }) => {
    // Validate regex compiles AND is not obviously catastrophic
    assertSafeRegex(data.rule.regex);
    const payload = { ...data.rule, user_id: context.userId };
    const q = data.id
      ? context.supabase.from("bot_parse_rules").update(payload).eq("id", data.id).select().single()
      : context.supabase.from("bot_parse_rules").insert(payload).select().single();
    const { data: row, error } = await q;
    if (error) throw error;
    return row;
  });

export const deleteParseRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("bot_parse_rules").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const listParseResults = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      accountIds: z.array(z.string().uuid()).optional(),
      field: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(500),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("bot_parse_results")
      .select("*")
      .order("captured_at", { ascending: false })
      .limit(data.limit);
    if (data.accountIds?.length) q = q.in("account_id", data.accountIds);
    if (data.field) q = q.eq("field_name", data.field);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const runParseScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      accountIds: z.array(z.string().uuid()).min(1).max(50),
      ruleIds: z.array(z.string().uuid()).min(1).max(20),
      messagesPerBot: z.number().int().min(1).max(200).default(30),
      concurrency: z.number().int().min(1).max(10).default(4),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { data: rules, error: rErr } = await context.supabase
      .from("bot_parse_rules").select("*").in("id", data.ruleIds);
    if (rErr) throw rErr;
    if (!rules?.length) throw new Error("No rules found");

    // Compile regexes once
    const compiled = rules.map((r) => {
      try { assertSafeRegex(r.regex); return { ...r, re: new RegExp(r.regex, "i"), disabled: false }; }
      catch { return { ...r, re: null as RegExp | null }; }
    });

    // Group rules by bot username
    const rulesByBot = new Map<string, typeof compiled>();
    for (const r of compiled) {
      const b = r.bot_username.replace(/^@/, "").toLowerCase();
      const arr = rulesByBot.get(b) ?? [];
      arr.push(r); rulesByBot.set(b, arr);
    }

    const inserts: any[] = [];
    const errors: Array<{ accountId: string; message: string }> = [];
    let scanned = 0, captured = 0;

    await runWithLimit(data.accountIds, data.concurrency, async (accountId) => {
      let client;
      try { client = await openClientForAccount(context.supabase, accountId, { requireOwnerId: context.userId }); }
      catch (e) { errors.push({ accountId, message: `Connect: ${(e as Error).message}` }); return; }
      try {
        for (const [botUsername, botRules] of rulesByBot) {
          try {
            const peer = await client.getEntity(botUsername);
            const msgs: any[] = await client.getMessages(peer, { limit: data.messagesPerBot });
            scanned += msgs.length;
            for (const m of msgs) {
              const text: string = String(m?.message ?? m?.text ?? "");
              if (!text) continue;
              for (const rule of botRules) {
                if (!rule.re) continue;
                let match: RegExpMatchArray | null;
                try {
                  match = safeMatch(text, rule.re);
                } catch (e) {
                  // Disable this rule for the remainder of the scan and record.
                  rule.re = null;
                  errors.push({ accountId, message: `Rule "${rule.name}" disabled: ${(e as Error).message}` });
                  continue;
                }
                if (!match) continue;
                const raw = match[1] ?? match[0];
                const num = Number(String(raw).replace(/[^0-9.\-]/g, ""));
                inserts.push({
                  user_id: context.userId,
                  rule_id: rule.id,
                  account_id: accountId,
                  bot_username: botUsername,
                  field_name: rule.field_name,
                  raw_text: text.slice(0, 500),
                  value_numeric: Number.isFinite(num) ? num : null,
                  value_text: String(raw).slice(0, 200),
                  captured_at: m?.date ? new Date(Number(m.date) * 1000).toISOString() : new Date().toISOString(),
                  classification: (rule as any).classification ?? null,
                });
                captured++;
                break; // one rule match per message
              }
            }
          } catch (e) {
            errors.push({ accountId, message: `${botUsername}: ${(e as Error).message}` });
          }
        }
      } finally { await client.disconnect().catch(() => {}); }
    });

    if (inserts.length) {
      // Insert in chunks
      for (let i = 0; i < inserts.length; i += 500) {
        const chunk = inserts.slice(i, i + 500);
        const { error } = await context.supabase.from("bot_parse_results").insert(chunk);
        if (error) errors.push({ accountId: "-", message: `Save: ${error.message}` });
      }
    }
    return { scanned, captured, errors };
  });

// ---------------------------------------------------------------------------
// #15 Bot response parser — curated presets
//
// Common outcomes almost every referral / airdrop bot emits. Each preset is
// classified so downstream dashboards (#13) can bucket results without more
// user config. Regexes are conservative (word-anchored, no backtracking traps)
// and pass assertSafeRegex.
// ---------------------------------------------------------------------------
const PRESETS: Array<{
  name: string;
  field_name: string;
  regex: string;
  classification: "success" | "warning" | "error" | "info";
  unit?: string | null;
}> = [
  { name: "Success",              field_name: "outcome_success",   regex: "\\b(success(ful)?|completed|done|verified|claimed|approved|granted)\\b", classification: "success" },
  { name: "Already registered",   field_name: "outcome_already",   regex: "\\b(already (registered|joined|claimed|verified|done|participated))\\b", classification: "info" },
  { name: "Banned",               field_name: "outcome_banned",    regex: "\\b(banned|blocked|suspended|blacklisted|permanently restricted)\\b", classification: "error" },
  { name: "Rate limited",         field_name: "outcome_ratelimit", regex: "\\b(too many requests|rate ?limit|slow down|try again later|flood ?wait)\\b", classification: "warning" },
  { name: "Insufficient balance", field_name: "outcome_lowbal",    regex: "\\b(insufficient (balance|funds)|not enough (balance|coins|points))\\b", classification: "warning" },
  { name: "Missing subscription", field_name: "outcome_notjoined", regex: "\\b(you (must|need to) (join|subscribe)|please join|not (a )?member)\\b", classification: "warning" },
  { name: "Referral counted",     field_name: "outcome_referral",  regex: "\\b(referral (counted|added|approved)|new referral|invited (a )?friend)\\b", classification: "success" },
  { name: "Balance",              field_name: "balance",           regex: "(?:balance|coins?|points?|earned|wallet)\\s*[:=]?\\s*([0-9]+(?:\\.[0-9]+)?)", classification: null as any, unit: null },
];

export const seedBotParsePresets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ botUsername: z.string().min(1).max(64) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const bot = data.botUsername.replace(/^@/, "").toLowerCase();
    // Fetch existing rule names for this bot so we can be idempotent.
    const { data: existing } = await context.supabase
      .from("bot_parse_rules")
      .select("name")
      .eq("user_id", context.userId)
      .eq("bot_username", bot);
    const have = new Set((existing ?? []).map((r: any) => String(r.name)));
    const toInsert = PRESETS
      .filter((p) => !have.has(p.name))
      .map((p) => ({
        user_id: context.userId,
        name: p.name,
        bot_username: bot,
        regex: p.regex,
        field_name: p.field_name,
        classification: p.classification,
        unit: p.unit ?? null,
      }));
    if (!toInsert.length) return { inserted: 0, skipped: PRESETS.length };
    const { error } = await context.supabase.from("bot_parse_rules").insert(toInsert);
    if (error) throw error;
    return { inserted: toInsert.length, skipped: PRESETS.length - toInsert.length };
  });

// ---------------------------------------------------------------------------
// #13 Bot success rate tracker
//
// Rolls three signals into one per-bot row:
//  1) referral_joins — deterministic joined/error/pending per (bot, account)
//  2) bot_parse_results — classification counts (success/warning/error/info)
//  3) action_runs kind='botflow' — total runs + avg completion duration
// ---------------------------------------------------------------------------
export const botSuccessDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ days: z.number().int().min(1).max(90).default(30) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();

    const [linksQ, joinsQ, parseQ, runsQ] = await Promise.all([
      context.supabase
        .from("referral_links")
        .select("id, bot_username")
        .eq("user_id", context.userId),
      context.supabase
        .from("referral_joins")
        .select("referral_link_id, status, joined_at, last_error, created_at")
        .eq("user_id", context.userId)
        .gte("created_at", since),
      context.supabase
        .from("bot_parse_results")
        .select("bot_username, classification, captured_at")
        .eq("user_id", context.userId)
        .gte("captured_at", since),
      context.supabase
        .from("action_runs")
        .select("id, status, params, created_at, updated_at")
        .eq("user_id", context.userId)
        .eq("kind", "botflow")
        .gte("created_at", since)
        .order("created_at", { ascending: false }),
    ]);

    if (linksQ.error) throw linksQ.error;
    if (joinsQ.error) throw joinsQ.error;
    if (parseQ.error) throw parseQ.error;
    if (runsQ.error) throw runsQ.error;

    // link_id -> bot_username
    const linkBot = new Map<string, string>();
    for (const l of linksQ.data ?? []) {
      linkBot.set(l.id as string, String(l.bot_username ?? "").toLowerCase().replace(/^@/, ""));
    }

    type Row = {
      bot: string;
      joined: number;
      errors: number;
      pending: number;
      joinPct: number;
      lastError: string | null;
      lastRunAt: string | null;
      runs: number;
      avgSec: number | null;
      class_success: number;
      class_warning: number;
      class_error: number;
      class_info: number;
    };
    const map = new Map<string, Row>();
    const ensure = (b: string): Row => {
      const key = (b || "unknown").toLowerCase().replace(/^@/, "");
      let r = map.get(key);
      if (!r) {
        r = {
          bot: key, joined: 0, errors: 0, pending: 0, joinPct: 0,
          lastError: null, lastRunAt: null, runs: 0, avgSec: null,
          class_success: 0, class_warning: 0, class_error: 0, class_info: 0,
        };
        map.set(key, r);
      }
      return r;
    };
    for (const b of linkBot.values()) ensure(b);

    // Referral join outcomes
    for (const j of joinsQ.data ?? []) {
      const bot = linkBot.get(j.referral_link_id as string);
      if (!bot) continue;
      const r = ensure(bot);
      const st = String(j.status ?? "pending");
      if (st === "joined") r.joined += 1;
      else if (st === "error") { r.errors += 1; if (!r.lastError && j.last_error) r.lastError = String(j.last_error).slice(0, 240); }
      else r.pending += 1;
    }

    // Parse classifications
    for (const p of parseQ.data ?? []) {
      const r = ensure(String(p.bot_username ?? ""));
      const c = String(p.classification ?? "");
      if (c === "success") r.class_success += 1;
      else if (c === "warning") r.class_warning += 1;
      else if (c === "error") r.class_error += 1;
      else if (c === "info") r.class_info += 1;
    }

    // Bot flow runs (bot username lives in params.op.bot)
    const durationsByBot = new Map<string, number[]>();
    for (const run of runsQ.data ?? []) {
      const bot = String((run as any)?.params?.op?.bot ?? "").toLowerCase().replace(/^@/, "");
      if (!bot) continue;
      const r = ensure(bot);
      r.runs += 1;
      if (!r.lastRunAt) r.lastRunAt = run.created_at as string;
      if (run.status === "completed" && run.updated_at && run.created_at) {
        const secs = (new Date(run.updated_at as string).getTime() - new Date(run.created_at as string).getTime()) / 1000;
        if (Number.isFinite(secs) && secs >= 0 && secs < 24 * 3600) {
          const arr = durationsByBot.get(bot) ?? [];
          arr.push(secs);
          durationsByBot.set(bot, arr);
        }
      }
    }
    for (const [bot, arr] of durationsByBot) {
      if (!arr.length) continue;
      const r = ensure(bot);
      r.avgSec = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    }

    for (const r of map.values()) {
      const denom = r.joined + r.errors + r.pending;
      r.joinPct = denom > 0 ? Math.round((r.joined / denom) * 100) : 0;
    }

    return {
      days: data.days,
      rows: [...map.values()].sort((a, b) => b.joined - a.joined || b.runs - a.runs),
    };
  });