import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useEffect } from "react";
import { getAnalytics } from "@/lib/analytics.functions";
import { Button } from "@/components/ui/button";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, Download } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid, Legend, PieChart, Pie, Cell } from "recharts";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/analytics")({
  beforeLoad: requireAdminBeforeLoad,
  component: () => <AdminGate><Page /></AdminGate>,
});

const COLORS = ["#5353ff", "#bd89ff", "#22c55e", "#ef4444", "#f59e0b", "#06b6d4", "#ec4899"];
const WEEKDAY = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

type DayPoint = { date: string; ok: number; error: number };
type MetricKey = "ok" | "err" | "runs";

function fillDays(perDay: DayPoint[], windowDays: number): DayPoint[] {
  const map = new Map(perDay.map((d) => [d.date, d]));
  const out: DayPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86400_000);
    const key = dt.toISOString().slice(0, 10);
    out.push(map.get(key) ?? { date: key, ok: 0, error: 0 });
  }
  return out;
}

function Page() {
  const fn = useServerFn(getAnalytics);
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ["analytics", days], queryFn: () => fn({ data: { fromDays: days } }) });
  const [openMetric, setOpenMetric] = useState<null | MetricKey>(null);

  const exportCsv = () => {
    if (!q.data) return;
    const rows = [["date", "ok", "error"], ...q.data.perDay.map((d) => [d.date, String(d.ok), String(d.error)])];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `analytics-${days}d.csv`;
    a.click();
  };

  const detailTitle: Record<MetricKey, string> = {
    ok: "Successful sends",
    err: "Errors",
    runs: "Runs",
  };
  const detailPick: Record<MetricKey, (d: DayPoint) => number> = {
    ok: (d) => d.ok,
    err: (d) => d.error,
    runs: (d) => d.ok + d.error,
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-3 md:px-8">
          <Link to="/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button></Link>
          <h1 className="mr-auto text-lg font-semibold">Analytics</h1>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="365">Last year</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!q.data}><Download className="mr-1 h-4 w-4" />CSV</Button>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 md:px-8">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {q.data && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <MetricCard title="Successful sends" unit="sends" tone="ok"
                perDay={q.data.perDay} pageDays={days} onRequestDays={setDays}
                pick={(d) => d.ok} onOpenFull={() => setOpenMetric("ok")} />
              <MetricCard title="Errors" unit="errs" tone="err"
                perDay={q.data.perDay} pageDays={days} onRequestDays={setDays}
                pick={(d) => d.error} onOpenFull={() => setOpenMetric("err")} />
              <MetricCard title="Runs" unit="runs" tone="gold"
                perDay={q.data.perDay} pageDays={days} onRequestDays={setDays}
                pick={(d) => d.ok + d.error} onOpenFull={() => setOpenMetric("runs")} />
            </div>

            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-sm font-semibold">Per day</div>
              <div style={{ height: 260 }}>
                <ResponsiveContainer>
                  <LineChart data={q.data.perDay}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="date" fontSize={11} />
                    <YAxis fontSize={11} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="ok" stroke="#22c55e" />
                    <Line type="monotone" dataKey="error" stroke="#ef4444" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-2 text-sm font-semibold">Top accounts</div>
                <div style={{ height: 320 }}>
                  <ResponsiveContainer>
                    <BarChart data={q.data.perAccount.slice(0, 15)}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="accountName" fontSize={10} angle={-30} textAnchor="end" height={70} interval={0} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="ok" stackId="a" fill="#22c55e" />
                      <Bar dataKey="error" stackId="a" fill="#ef4444" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-2 text-sm font-semibold">Kind breakdown</div>
                <div style={{ height: 320 }}>
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={q.data.perKind} dataKey="ok" nameKey="kind" outerRadius={100} label>
                        {q.data.perKind.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card">
              <div className="border-b border-border p-3 text-sm font-semibold">Top 25 targets</div>
              <table className="w-full text-xs">
                <thead className="bg-muted/30 text-left"><tr><th className="p-2">Target</th><th className="p-2">Sends</th></tr></thead>
                <tbody>
                  {q.data.topTargets.map((t) => (
                    <tr key={t.target} className="border-t border-border"><td className="p-2 font-mono break-all">{t.target}</td><td className="p-2">{t.count}</td></tr>
                  ))}
                </tbody>
              </table>
              {!q.data.topTargets.length && <p className="p-3 text-sm text-muted-foreground">No data.</p>}
            </div>

            <MetricDetailDialog
              open={openMetric !== null}
              onOpenChange={(o) => !o && setOpenMetric(null)}
              title={openMetric ? detailTitle[openMetric] : ""}
              perDay={q.data.perDay}
              windowDays={days}
              pick={openMetric ? detailPick[openMetric] : () => 0}
            />
          </>
        )}
      </div>
    </main>
  );
}

type Tone = "ok" | "err" | "gold";

function MetricCard({
  title, unit, perDay, pageDays, onRequestDays, pick, tone = "gold", onOpenFull,
}: {
  title: string;
  unit: string;
  perDay: DayPoint[];
  pageDays: number;
  onRequestDays: (n: number) => void;
  pick: (d: DayPoint) => number;
  tone?: Tone;
  onOpenFull?: () => void;
}) {
  const [range, setRange] = useState<7 | 14 | 30>(7);

  // If user chooses a wider range than the page fetched, bump the page query.
  useEffect(() => {
    if (range > pageDays) onRequestDays(range);
  }, [range, pageDays, onRequestDays]);

  const filled = useMemo(() => fillDays(perDay, range), [perDay, range]);

  const bars = filled.map((d, i) => {
    const dt = new Date(d.date + "T00:00:00Z");
    const label = range <= 7 ? WEEKDAY[dt.getUTCDay()] : String(dt.getUTCDate());
    return { date: d.date, label, value: pick(d), i };
  });

  const total = bars.reduce((s, b) => s + b.value, 0);
  const minVal = bars.length ? Math.min(...bars.map((b) => b.value)) : 0;
  const maxVal = bars.length ? Math.max(...bars.map((b) => b.value)) : 0;
  const avg = bars.length ? Math.round(total / bars.length) : 0;
  const chartMax = Math.max(1, maxVal);
  const avgTopPct = Math.min(90, Math.max(10, 100 - (avg / chartMax) * 100));

  const nonZero = [...bars].reverse().filter((b) => b.value > 0).slice(0, 3);
  const readings = (nonZero.length ? nonZero : [...bars].reverse().slice(0, 3))
    .map((b) => ({ time: b.date, value: b.value }));

  const gradient = tone === "ok"
    ? "from-emerald-400 to-emerald-600"
    : tone === "err"
    ? "from-rose-400 to-rose-600"
    : "from-amber-300 to-amber-500";
  const dotBorder = tone === "ok" ? "border-emerald-400" : tone === "err" ? "border-rose-400" : "border-amber-400";

  const barWidth = range > 14 ? "w-1.5" : range > 7 ? "w-3" : "w-5";
  const labelStep = Math.max(1, Math.ceil(range / 7));

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-bold text-foreground">{title}</span>
        <button
          onClick={onOpenFull}
          className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Full stats →
        </button>
      </div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-1">
        <span className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{total.toLocaleString()}</span>
        <span className="text-xl font-light text-muted-foreground sm:text-2xl">{unit}</span>
        {bars.length > 1 && (
          <span className="ml-1 text-[10px] text-muted-foreground">{minVal}–{maxVal} range</span>
        )}
      </div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">Last {range} days</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          {[7, 14, 30].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r as 7 | 14 | 30)}
              className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                range === r ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      <div className="relative mb-5 h-24 sm:h-28">
        <div className="absolute inset-x-0 z-[1] h-px bg-border" style={{ top: `${avgTopPct}%` }} />
        <div
          className="absolute right-0 z-[2] rounded-md bg-foreground px-2 py-0.5 text-[10px] font-semibold text-background"
          style={{ top: `calc(${avgTopPct}% - 20px)` }}
        >
          Avg. {avg}
        </div>
        <div className="relative flex h-full items-end justify-around gap-[2px] overflow-hidden px-1 sm:gap-1 sm:px-2">
          {bars.map((b, i) => {
            const h = Math.max(6, (b.value / chartMax) * 72);
            const isPeak = maxVal > 0 && b.value === maxVal;
            const isLow = bars.length > 1 && b.value === minVal && b.value !== maxVal;
            const showLabel = i % labelStep === 0 || i === bars.length - 1;
            return (
              <div key={i} className="z-[2] flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <div
                  className={`relative ${barWidth} rounded-full bg-gradient-to-b ${gradient} transition-transform hover:scale-105`}
                  style={{ height: `${h}px` }}
                  title={`${b.date}: ${b.value}`}
                >
                  {isPeak && (
                    <div className={`absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] ${dotBorder} bg-background`} />
                  )}
                  {isLow && (
                    <div className={`absolute bottom-0 left-1/2 h-2 w-2 -translate-x-1/2 translate-y-1/2 rounded-full border-[1.5px] ${dotBorder} bg-background`} />
                  )}
                </div>
                {showLabel ? (
                  <div className="text-[9px] font-medium text-muted-foreground">{b.label}</div>
                ) : (
                  <div className="h-[11px]" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border pt-3">
        {readings.map((r, i) => (
          <div
            key={i}
            className={`flex items-center justify-between py-2 ${
              i < readings.length - 1 ? "border-b border-border" : ""
            }`}
          >
            <span className="text-[10px] text-muted-foreground">{r.time}</span>
            <span className="text-xs font-bold text-foreground">{r.value.toLocaleString()}</span>
          </div>
        ))}
        {!readings.length && <div className="py-2 text-[10px] text-muted-foreground">No recent data</div>}
      </div>
    </div>
  );
}

function MetricDetailDialog({
  open, onOpenChange, title, perDay, windowDays, pick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  perDay: DayPoint[];
  windowDays: number;
  pick: (d: DayPoint) => number;
}) {
  const filled = useMemo(() => fillDays(perDay, windowDays), [perDay, windowDays]);
  const rows = filled.map((d) => ({ date: d.date, value: pick(d) }));
  const total = rows.reduce((s, r) => s + r.value, 0);
  const avg = rows.length ? Math.round(total / rows.length) : 0;
  const peak = rows.reduce((m, r) => (r.value > m.value ? r : m), rows[0] ?? { date: "-", value: 0 });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title} — last {windowDays} days</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <MiniStat label="Total" value={total} />
          <MiniStat label="Daily avg" value={avg} />
          <MiniStat label={`Peak (${peak.date})`} value={peak.value} />
        </div>
        <div className="h-64 w-full sm:h-72">
          <ResponsiveContainer>
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="date" fontSize={10} interval={Math.max(0, Math.floor(rows.length / 10))} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="max-h-56 overflow-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/40 text-left">
              <tr><th className="p-2">Date</th><th className="p-2 text-right">Value</th></tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.date} className="border-t border-border">
                  <td className="p-2 font-mono">{r.date}</td>
                  <td className="p-2 text-right">{r.value.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="truncate text-[10px] text-muted-foreground">{label}</div>
      <div className="text-lg font-bold text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}