import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getAnalytics } from "@/lib/analytics.functions";
import { Button } from "@/components/ui/button";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, Download } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid, Legend, PieChart, Pie, Cell } from "recharts";

export const Route = createFileRoute("/_authenticated/analytics")({
  component: () => <AdminGate><Page /></AdminGate>,
});

const COLORS = ["#5353ff", "#bd89ff", "#22c55e", "#ef4444", "#f59e0b", "#06b6d4", "#ec4899"];

function Page() {
  const fn = useServerFn(getAnalytics);
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ["analytics", days], queryFn: () => fn({ data: { fromDays: days } }) });

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

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 md:px-8">
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
              <MetricCard
                title="Successful sends"
                value={q.data.totals.ok}
                unit="sends"
                dateRange={`Last ${days} days`}
                series={q.data.perDay.map((d) => ({ label: d.date.slice(5), value: d.ok }))}
                readings={q.data.perDay.slice(-2).reverse().map((d) => ({ time: d.date, value: d.ok }))}
                tone="ok"
              />
              <MetricCard
                title="Errors"
                value={q.data.totals.error}
                unit="errs"
                dateRange={`Last ${days} days`}
                series={q.data.perDay.map((d) => ({ label: d.date.slice(5), value: d.error }))}
                readings={q.data.perDay.slice(-2).reverse().map((d) => ({ time: d.date, value: d.error }))}
                tone="err"
              />
              <MetricCard
                title="Runs"
                value={q.data.totals.runs}
                unit="runs"
                dateRange={`Last ${days} days`}
                series={q.data.perDay.map((d) => ({ label: d.date.slice(5), value: d.ok + d.error }))}
                readings={q.data.perDay.slice(-2).reverse().map((d) => ({ time: d.date, value: d.ok + d.error }))}
                tone="gold"
              />
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
                    <tr key={t.target} className="border-t border-border"><td className="p-2 font-mono">{t.target}</td><td className="p-2">{t.count}</td></tr>
                  ))}
                </tbody>
              </table>
              {!q.data.topTargets.length && <p className="p-3 text-sm text-muted-foreground">No data.</p>}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

type Tone = "ok" | "err" | "gold";

function MetricCard({
  title,
  value,
  unit,
  dateRange,
  series,
  readings,
  tone = "gold",
}: {
  title: string;
  value: number;
  unit: string;
  dateRange: string;
  series: { label: string; value: number }[];
  readings: { time: string; value: number }[];
  tone?: Tone;
}) {
  const gradient =
    tone === "ok"
      ? "from-emerald-400 to-emerald-600"
      : tone === "err"
      ? "from-rose-400 to-rose-600"
      : "from-amber-300 to-amber-500";
  const dotBorder =
    tone === "ok" ? "border-emerald-400" : tone === "err" ? "border-rose-400" : "border-amber-400";

  const bars = series.slice(-7);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const avg = bars.length ? Math.round(bars.reduce((s, b) => s + b.value, 0) / bars.length) : 0;
  const avgPctFromTop = 100 - (avg / max) * 100;

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-bold text-foreground">{title}</span>
        <button className="rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-semibold text-foreground transition-colors hover:bg-muted">
          Full stats →
        </button>
      </div>
      <div className="mb-1">
        <span className="text-3xl font-bold tracking-tight text-foreground">{value.toLocaleString()}</span>
        <span className="ml-1 text-2xl font-light text-muted-foreground">{unit}</span>
      </div>
      <div className="mb-5 text-[11px] text-muted-foreground">{dateRange}</div>

      <div className="relative mb-5 h-24">
        <div
          className="absolute inset-x-0 z-[1] h-px bg-border"
          style={{ top: `${Math.min(90, Math.max(10, avgPctFromTop))}%` }}
        />
        <div
          className="absolute right-0 z-[2] rounded-md bg-foreground px-2 py-0.5 text-[10px] font-semibold text-background"
          style={{ top: `calc(${Math.min(90, Math.max(10, avgPctFromTop))}% - 20px)` }}
        >
          Avg. {avg}
        </div>
        <div className="relative flex h-full items-end justify-around gap-1 px-2">
          {bars.map((b, i) => {
            const h = Math.max(8, (b.value / max) * 72);
            const isPeak = b.value === max && max > 0;
            const isLow = b.value === Math.min(...bars.map((x) => x.value));
            return (
              <div key={i} className="z-[2] flex flex-1 flex-col items-center gap-1.5">
                <div
                  className={`relative w-5 rounded-full bg-gradient-to-b ${gradient} transition-transform hover:scale-105`}
                  style={{ height: `${h}px` }}
                  title={`${b.label}: ${b.value}`}
                >
                  {isPeak && (
                    <div
                      className={`absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] ${dotBorder} bg-background`}
                    />
                  )}
                  {isLow && bars.length > 1 && (
                    <div
                      className={`absolute bottom-0 left-1/2 h-2 w-2 -translate-x-1/2 translate-y-1/2 rounded-full border-[1.5px] ${dotBorder} bg-background`}
                    />
                  )}
                </div>
                <div className="text-[9px] font-medium text-muted-foreground">{b.label}</div>
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