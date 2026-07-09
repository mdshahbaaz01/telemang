import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

function nowIstParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

export const Route = createFileRoute("/api/public/hooks/daily-summary")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = request.headers.get("apikey") ?? request.headers.get("authorization")?.replace("Bearer ", "");
        if (!key) return new Response("Missing key", { status: 401 });
        const supabase = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { autoRefreshToken: false, persistSession: false } },
        );

        const { date, hhmm } = nowIstParts();
        const { data: settings, error } = await (supabase as any)
          .from("notification_settings")
          .select("user_id, daily_summary_ist_time, daily_summary_last_sent_date")
          .not("daily_summary_ist_time", "is", null);
        if (error) return Response.json({ error: error.message }, { status: 500 });

        const due = (settings ?? []).filter((s: any) => {
          if (!s.daily_summary_ist_time) return false;
          if (s.daily_summary_last_sent_date === date) return false;
          const target = String(s.daily_summary_ist_time).slice(0, 5);
          return hhmm >= target;
        });
        if (!due.length) return Response.json({ processed: 0 });

        const { notifyOwner } = await import("@/lib/notifications.server");
        let sent = 0;
        for (const s of due) {
          const dayStart = new Date();
          dayStart.setUTCHours(0, 0, 0, 0);
          const { count: runCount } = await (supabase as any)
            .from("action_runs")
            .select("id", { count: "exact", head: true })
            .eq("user_id", s.user_id)
            .gte("created_at", dayStart.toISOString());
          const { count: broadcastCount } = await (supabase as any)
            .from("scheduled_broadcasts")
            .select("id", { count: "exact", head: true })
            .eq("user_id", s.user_id)
            .gte("created_at", dayStart.toISOString());
          const body = `Runs today: ${runCount ?? 0}\nScheduled broadcasts today: ${broadcastCount ?? 0}`;
          try {
            await notifyOwner(supabase as any, s.user_id as string, "daily_summary", "Daily summary", body);
            await (supabase as any)
              .from("notification_settings")
              .update({ daily_summary_last_sent_date: date })
              .eq("user_id", s.user_id);
            sent++;
          } catch {}
        }
        return Response.json({ processed: due.length, sent });
      },
    },
  },
});