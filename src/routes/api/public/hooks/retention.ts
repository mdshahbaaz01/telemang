import { createFileRoute } from "@tanstack/react-router";

// Trims old rows from log tables. Invoked by pg_cron on a daily schedule.
export const Route = createFileRoute("/api/public/hooks/retention")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyHookAuth } = await import("@/lib/hook-auth.server");
        const denied = verifyHookAuth(request);
        if (denied) return denied;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.rpc("run_log_retention");
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }
        return Response.json({ ok: true, deleted: data });
      },
    },
  },
});