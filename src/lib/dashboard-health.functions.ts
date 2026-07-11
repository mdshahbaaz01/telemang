import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AccountHealth = {
  id: string;
  name: string;
  phone: string | null;
  status: string;
  pausedUntil: string | null;
  floodWaitSeconds: number | null;
  lastError: string | null;
  lastUsed: string | null;
  usage24h: { msgs: number; joins: number; leaves: number; errors: number };
};

export const getAccountsHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AccountHealth[]> => {
    const { data: accs, error } = await context.supabase
      .from("telegram_accounts")
      .select("id, phone, first_name, username, status, paused_until, last_error, updated_at")
      .order("first_name", { ascending: true });
    if (error) throw new Error(error.message);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Get last 24h logs, tagged by run kind (join/leave/broadcast/etc).
    const { data: runs } = await context.supabase
      .from("action_runs")
      .select("id, kind, started_at")
      .gte("started_at", since);
    const runKind = new Map<string, string>((runs ?? []).map((r: any) => [r.id, r.kind]));
    const runIds = Array.from(runKind.keys());

    const perAcc = new Map<
      string,
      { msgs: number; joins: number; leaves: number; errors: number }
    >();
    if (runIds.length) {
      const { data: logs } = await context.supabase
        .from("action_logs")
        .select("run_id, account_id, level, message")
        .in("run_id", runIds);
      for (const l of logs ?? []) {
        if (!l.account_id) continue;
        const bucket = perAcc.get(l.account_id) ?? { msgs: 0, joins: 0, leaves: 0, errors: 0 };
        const kind = runKind.get(l.run_id as string) ?? "";
        if (l.level === "error") bucket.errors++;
        else if (l.level === "success") {
          if (/^(broadcast|reply|forward|react|vote|edit)$/i.test(kind)) bucket.msgs++;
          if (/join/i.test(l.message ?? "") || /^join/i.test(kind)) bucket.joins++;
          if (/left|leave/i.test(l.message ?? "")) bucket.leaves++;
        }
        perAcc.set(l.account_id, bucket);
      }
    }

    return (accs ?? []).map((a: any) => {
      const paused = a.paused_until ? new Date(a.paused_until).getTime() : 0;
      const secs = paused > Date.now() ? Math.ceil((paused - Date.now()) / 1000) : null;
      return {
        id: a.id,
        name: a.first_name || a.username || a.phone || a.id.slice(0, 6),
        phone: a.phone,
        status: a.status,
        pausedUntil: a.paused_until,
        floodWaitSeconds: secs,
        lastError: a.last_error,
        lastUsed: a.updated_at,
        usage24h: perAcc.get(a.id) ?? { msgs: 0, joins: 0, leaves: 0, errors: 0 },
      };
    });
  });