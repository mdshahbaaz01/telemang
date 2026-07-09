import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/hooks/auto-leave")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyHookAuth } = await import("@/lib/hook-auth.server");
        const denied = verifyHookAuth(request);
        if (denied) return denied;
        const supabase = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { autoRefreshToken: false, persistSession: false } },
        );

        const nowIso = new Date().toISOString();
        const { data: items, error } = await (supabase as any)
          .from("join_task_items")
          .select("id, target, task_id, join_tasks(account_id)")
          .lt("leave_after", nowIso)
          .is("left_at", null)
          .eq("status", "joined")
          .limit(200);
        if (error) return Response.json({ error: error.message }, { status: 500 });
        if (!items?.length) return Response.json({ processed: 0 });

        const { openClientForAccount } = await import("@/lib/cleanup.server");
        const { Api } = await import("telegram");
        let ok = 0;
        let fail = 0;

        for (const item of items) {
          const accountId = (item as any).join_tasks?.account_id as string | undefined;
          if (!accountId) { fail++; continue; }
          let client;
          try {
            client = await openClientForAccount(supabase as any, accountId);
          } catch {
            fail++;
            continue;
          }
          try {
            const target = String((item as any).target ?? "").replace(/^@/, "");
            const entity = await client.getEntity(target);
            await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
            await (supabase as any).from("join_task_items").update({ left_at: nowIso, status: "left" }).eq("id", item.id);
            ok++;
          } catch (e) {
            fail++;
            await (supabase as any).from("join_task_items").update({ error: (e as Error).message }).eq("id", item.id);
          } finally {
            await client.disconnect().catch(() => {});
          }
        }
        return Response.json({ processed: items.length, ok, fail });
      },
    },
  },
});