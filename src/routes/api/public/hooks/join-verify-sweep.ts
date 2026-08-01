import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/hooks/join-verify-sweep")({
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
        const { runJoinVerifySweep } = await import("@/lib/join-sweep.server");
        try {
          const summary = await runJoinVerifySweep(supabase as any, { limit: 120 });
          return Response.json(summary);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});