import { createFileRoute } from "@tanstack/react-router";

// Trims old rows from log tables. Invoked by pg_cron on a daily schedule.
export const Route = createFileRoute("/api/public/hooks/retention")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey");
        if (apiKey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("Unauthorized", { status: 401 });
        }
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