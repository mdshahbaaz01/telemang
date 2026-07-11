import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AnalyticsSummary = {
  totals: { ok: number; error: number; runs: number };
  perDay: Array<{ date: string; ok: number; error: number }>;
  perAccount: Array<{ accountId: string; accountName: string; ok: number; error: number }>;
  perKind: Array<{ kind: string; ok: number; error: number }>;
  topTargets: Array<{ target: string; count: number }>;
};

export const getAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      fromDays: z.number().int().min(1).max(365).default(30),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<AnalyticsSummary> => {
    const from = new Date(Date.now() - data.fromDays * 86400_000).toISOString();

    // Load runs + logs in parallel
    const [runsRes, logsRes, accsRes] = await Promise.all([
      context.supabase.from("action_runs").select("id, kind, created_at, totals").gte("created_at", from),
      context.supabase.from("action_logs").select("account_id, target, level, created_at").gte("created_at", from).limit(20000),
      context.supabase.from("telegram_accounts").select("id, first_name, username, phone"),
    ]);
    if (runsRes.error) throw runsRes.error;
    if (logsRes.error) throw logsRes.error;

    const logs = logsRes.data ?? [];
    const runs = runsRes.data ?? [];
    const nameFor = new Map<string, string>();
    for (const a of accsRes.data ?? []) {
      nameFor.set(a.id as string, (a.first_name || a.username || a.phone || (a.id as string).slice(0, 6)) as string);
    }

    // Totals from logs (success/error)
    let ok = 0, error = 0;
    const perDayMap = new Map<string, { ok: number; error: number }>();
    const perAccMap = new Map<string, { ok: number; error: number }>();
    const targetMap = new Map<string, number>();

    for (const l of logs) {
      const isOk = l.level === "success" || l.level === "ok";
      const isErr = l.level === "error";
      if (!isOk && !isErr) continue;
      if (isOk) ok++; else error++;

      const day = String(l.created_at).slice(0, 10);
      const d = perDayMap.get(day) ?? { ok: 0, error: 0 };
      if (isOk) d.ok++; else d.error++;
      perDayMap.set(day, d);

      if (l.account_id) {
        const a = perAccMap.get(l.account_id) ?? { ok: 0, error: 0 };
        if (isOk) a.ok++; else a.error++;
        perAccMap.set(l.account_id, a);
      }
      if (isOk && l.target) targetMap.set(l.target, (targetMap.get(l.target) ?? 0) + 1);
    }

    // Per-kind from runs (ok/fail already aggregated)
    const perKindMap = new Map<string, { ok: number; error: number }>();
    for (const r of runs) {
      const k = String(r.kind ?? "unknown");
      const cur = perKindMap.get(k) ?? { ok: 0, error: 0 };
      const t = (r.totals ?? {}) as { ok?: number; fail?: number };
      cur.ok += Number(t.ok ?? 0);
      cur.error += Number(t.fail ?? 0);
      perKindMap.set(k, cur);
    }

    const perDay = [...perDayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));
    const perAccount = [...perAccMap.entries()]
      .map(([accountId, v]) => ({ accountId, accountName: nameFor.get(accountId) ?? accountId.slice(0, 6), ...v }))
      .sort((a, b) => (b.ok + b.error) - (a.ok + a.error))
      .slice(0, 50);
    const perKind = [...perKindMap.entries()].map(([kind, v]) => ({ kind, ...v }));
    const topTargets = [...targetMap.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 25)
      .map(([target, count]) => ({ target, count }));

    return {
      totals: { ok, error, runs: runs.length },
      perDay, perAccount, perKind, topTargets,
    };
  });