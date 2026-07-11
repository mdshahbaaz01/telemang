import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const schema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(50),
  targets: z.array(z.string().min(1)).min(1).max(500),
  deep: z.boolean().optional().default(true),
});

export type PrecheckResult = {
  accountId: string;
  accountLabel: string;
  results: Array<{ target: string; ok: boolean; kind?: string; reason?: string }>;
};

export const precheckBroadcastTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => schema.parse(d))
  .handler(async ({ data, context }): Promise<PrecheckResult[]> => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { resolveTargetEntity } = await import("./telegram-target-resolver.server");
    const { Api } = await import("telegram");

    const { data: accts, error } = await context.supabase
      .from("telegram_accounts")
      .select("id, first_name, last_name, username, phone")
      .in("id", data.accountIds);
    if (error) throw new Error(error.message);
    const labelOf = (a: any) =>
      a.first_name || a.username || a.phone || a.id.slice(0, 8);

    // De-dup targets
    const targets = Array.from(new Set(data.targets.map((t) => t.trim()).filter(Boolean)));

    const out: PrecheckResult[] = [];

    for (const acctId of data.accountIds) {
      const acct = (accts ?? []).find((a) => a.id === acctId);
      const label = acct ? labelOf(acct) : acctId.slice(0, 8);
      const entry: PrecheckResult = { accountId: acctId, accountLabel: label, results: [] };

      let client: any = null;
      try {
        client = await openClientForAccount(context.supabase, acctId, {
          requireOwnerId: context.userId,
        });
      } catch (e: any) {
        for (const t of targets) {
          entry.results.push({ target: t, ok: false, reason: e?.message || "client open failed" });
        }
        out.push(entry);
        continue;
      }

      try {
        for (const t of targets) {
          try {
            const ent: any = data.deep
              ? await resolveTargetEntity(client, Api, t)
              : await client.getInputEntity(
                  /^-?\d+$/.test(t.trim()) ? Number(t.trim()) : t.trim().replace(/^@/, ""),
                );
            const cn = ent?.className || ent?.constructor?.name || "";
            const kind = /Channel/i.test(cn)
              ? "channel/group"
              : /Chat/i.test(cn)
              ? "group"
              : /User/i.test(cn)
              ? "user"
              : "peer";
            entry.results.push({ target: t, ok: true, kind });
          } catch (e: any) {
            entry.results.push({
              target: t,
              ok: false,
              reason: (e?.message || String(e)).slice(0, 240),
            });
          }
        }
      } finally {
        await client.disconnect().catch(() => {});
      }

      out.push(entry);
    }

    return out;
  });