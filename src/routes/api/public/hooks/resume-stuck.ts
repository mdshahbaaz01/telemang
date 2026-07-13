import { createFileRoute } from "@tanstack/react-router";

// Marks tasks/broadcasts as resumable when the worker heartbeat is stale.
// The next worker tick will pick them up from progress_cursor.
export const Route = createFileRoute("/api/public/hooks/resume-stuck")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyHookAuth } = await import("@/lib/hook-auth.server");
        const denied = verifyHookAuth(request);
        if (denied) return denied;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();

        const { data: staleTasks } = await supabaseAdmin
          .from("join_tasks")
          .select("id, resume_count")
          .eq("status", "running")
          .or(`heartbeat_at.is.null,heartbeat_at.lt.${staleBefore}`)
          .limit(50);

        let taskCount = 0;
        for (const t of staleTasks ?? []) {
          await supabaseAdmin
            .from("join_tasks")
            .update({
              status: "idle",
              resumed_at: new Date().toISOString(),
              resume_count: ((t as any).resume_count ?? 0) + 1,
            })
            .eq("id", (t as any).id);
          taskCount++;
        }

        const { data: staleBroadcasts } = await supabaseAdmin
          .from("scheduled_broadcasts")
          .select("id, resume_count")
          .eq("status", "running")
          .or(`heartbeat_at.is.null,heartbeat_at.lt.${staleBefore}`)
          .limit(50);

        let bcCount = 0;
        for (const b of staleBroadcasts ?? []) {
          await supabaseAdmin
            .from("scheduled_broadcasts")
            .update({
              status: "pending",
              resumed_at: new Date().toISOString(),
              resume_count: ((b as any).resume_count ?? 0) + 1,
            })
            .eq("id", (b as any).id);
          bcCount++;
        }

        return Response.json({ ok: true, resumedTasks: taskCount, resumedBroadcasts: bcCount });
      },
    },
  },
});