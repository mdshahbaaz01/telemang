import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader } from "@/components/ui/loader";
import { RefreshCw, Activity, AlertTriangle, Users, Send, Bell, Zap } from "lucide-react";
import { getHealthMetrics, type HealthMetrics } from "@/lib/health.functions";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/health")({
  beforeLoad: requireAdminBeforeLoad,
  component: HealthPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-destructive">Failed to load: {String(error)}</div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

const WINDOWS: Array<{ label: string; minutes: number }> = [
  { label: "5m", minutes: 5 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
];

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "ok" | "warn" | "err" | "muted" }) {
  const toneClass =
    tone === "err" ? "text-destructive" :
    tone === "warn" ? "text-amber-500" :
    tone === "ok" ? "text-emerald-500" :
    "text-foreground";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

function HealthPage() {
  const fetchMetrics = useServerFn(getHealthMetrics);
  const [windowMinutes, setWindowMinutes] = useState(60);

  const { data, isLoading, isFetching, refetch } = useQuery<HealthMetrics>({
    queryKey: ["health-metrics", windowMinutes],
    queryFn: () => fetchMetrics({ data: { windowMinutes } }),
    refetchInterval: 15_000,
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Activity className="h-6 w-6" /> Health & Runtime Metrics
          </h1>
          <p className="text-sm text-muted-foreground">
            Live view of joins, tasks, broadcasts, and account pressure over the last {windowMinutes < 60 ? `${windowMinutes}m` : `${windowMinutes / 60}h`}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {WINDOWS.map((w) => (
            <Button
              key={w.minutes}
              size="sm"
              variant={windowMinutes === w.minutes ? "default" : "outline"}
              onClick={() => setWindowMinutes(w.minutes)}
            >
              {w.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="flex justify-center p-12"><Loader /></div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4" /> Actions</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-3 gap-3">
                <Stat label="Total" value={data.actions.total} />
                <Stat label="OK" value={data.actions.ok} tone="ok" />
                <Stat label="Floods" value={data.actions.floods} tone={data.actions.floods > 0 ? "warn" : "muted"} />
                <Stat label="Failed" value={data.actions.failures} tone={data.actions.failures > 0 ? "err" : "muted"} />
                <Stat label="Skipped" value={data.actions.skipped} tone="muted" />
                <Stat label="Max flood" value={`${data.actions.max_flood_seconds}s`} tone={data.actions.max_flood_seconds > 30 ? "warn" : "muted"} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Users className="h-4 w-4" /> Accounts</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <Stat label="Total" value={data.accounts.total} />
                <Stat label="Active" value={data.accounts.active} tone="ok" />
                <Stat label="Paused" value={data.accounts.paused} tone={data.accounts.paused > 0 ? "warn" : "muted"} />
                <Stat label="Errored" value={data.accounts.error} tone={data.accounts.error > 0 ? "err" : "muted"} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Send className="h-4 w-4" /> Tasks & Broadcasts</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <Stat label="Running" value={data.tasks.running} tone={data.tasks.running > 0 ? "ok" : "muted"} />
                <Stat label="Queued" value={data.tasks.queued} />
                <Stat label="Stale" value={data.tasks.stale} tone={data.tasks.stale > 0 ? "warn" : "muted"} />
                <Stat label="Failed" value={data.tasks.failed} tone={data.tasks.failed > 0 ? "err" : "muted"} />
                <Stat label="B. pending" value={data.broadcasts.pending} />
                <Stat label="B. failed" value={data.broadcasts.failed} tone={data.broadcasts.failed > 0 ? "err" : "muted"} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Bell className="h-4 w-4" /> Idempotency & Notifications</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <Stat label="In-flight" value={data.idempotency.in_flight} tone={data.idempotency.in_flight > 0 ? "ok" : "muted"} />
                <Stat label="Done" value={data.idempotency.done} />
                <Stat label="Idem failed" value={data.idempotency.failed} tone={data.idempotency.failed > 0 ? "err" : "muted"} />
                <Stat label="Notif sent" value={data.notifications.sent} tone="ok" />
                <Stat label="Notif failed" value={data.notifications.failed} tone={data.notifications.failed > 0 ? "err" : "muted"} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Per-account pressure</CardTitle></CardHeader>
            <CardContent>
              {data.per_account.length === 0 ? (
                <p className="text-sm text-muted-foreground">No account activity in this window.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-2 px-2">Account</th>
                        <th className="text-right py-2 px-2">Attempts</th>
                        <th className="text-right py-2 px-2">Floods</th>
                        <th className="text-right py-2 px-2">Failures</th>
                        <th className="text-right py-2 px-2">Max flood (s)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.per_account.map((a) => (
                        <tr key={a.account_id} className="border-b last:border-0">
                          <td className="py-2 px-2 font-medium">{a.account_label || a.account_id.slice(0, 8)}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{a.total}</td>
                          <td className="py-2 px-2 text-right tabular-nums">
                            {a.floods > 0 ? <Badge variant="outline" className="text-amber-500 border-amber-500/40">{a.floods}</Badge> : a.floods}
                          </td>
                          <td className="py-2 px-2 text-right tabular-nums">
                            {a.failures > 0 ? <Badge variant="destructive">{a.failures}</Badge> : a.failures}
                          </td>
                          <td className="py-2 px-2 text-right tabular-nums">{a.max_flood_seconds}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> Recent errors
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.recent_errors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No errors in this window. All clear.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.recent_errors.map((e, i) => (
                    <li key={i} className="flex items-start gap-3 border-b last:border-0 pb-2">
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        {new Date(e.created_at).toLocaleTimeString()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs truncate">{e.target || "—"}</div>
                        <div className="text-destructive text-xs">{e.error || "unknown"}</div>
                      </div>
                      {e.source && <Badge variant="outline" className="text-[10px]">{e.source}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground text-right">
            Updated {new Date(data.generated_at).toLocaleTimeString()} · auto-refresh 15s
          </p>
        </>
      )}
    </div>
  );
}