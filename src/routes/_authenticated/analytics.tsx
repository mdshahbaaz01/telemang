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
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Successful sends" value={q.data.totals.ok} tone="ok" />
              <Stat label="Errors" value={q.data.totals.error} tone="err" />
              <Stat label="Runs" value={q.data.totals.runs} />
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "err" }) {
  const c = tone === "ok" ? "text-green-500" : tone === "err" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${c}`}>{value.toLocaleString()}</div>
    </div>
  );
}