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