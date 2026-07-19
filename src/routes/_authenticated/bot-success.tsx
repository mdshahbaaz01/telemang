import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { botSuccessDashboard, seedBotParsePresets } from "@/lib/bot-parser.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminGate } from "@/components/AdminGate";
import { requireAdminBeforeLoad } from "@/lib/access-guard";
import { ArrowLeft, ArrowUpDown, Sparkles, RefreshCw, Trophy, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/bot-success")({
  beforeLoad: requireAdminBeforeLoad,
  component: () => <AdminGate><Page /></AdminGate>,
});

type SortKey = "bot" | "joinPct" | "joined" | "errors" | "runs" | "avgSec" | "class_success" | "class_error" | "lastRunAt";

function Page() {
  const dashFn = useServerFn(botSuccessDashboard);
  const seedFn = useServerFn(seedBotParsePresets);
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const [sort, setSort] = useState<SortKey>("joinPct");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [seedBot, setSeedBot] = useState("");

  const q = useQuery({
    queryKey: ["bot-success", days],
    queryFn: () => dashFn({ data: { days } }),
  });

  const rows = useMemo(() => {
    const list = [...(q.data?.rows ?? [])];
    list.sort((a, b) => {
      const av = (a as any)[sort];
      const bv = (b as any)[sort];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      return dir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return list;
  }, [q.data, sort, dir]);

  const toggle = (k: SortKey) => {
    if (sort === k) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(k); setDir("desc"); }
  };

  const seed = async () => {
    const bot = seedBot.trim().replace(/^@/, "");
    if (!bot) return toast.error("Enter a bot username to seed presets for");
    try {
      const res = await seedFn({ data: { botUsername: bot } });
      toast.success(`Presets seeded — inserted ${res.inserted}, skipped ${res.skipped}`);
      setSeedBot("");
      qc.invalidateQueries({ queryKey: ["bot-success"] });
    } catch (e) { toast.error((e as Error).message); }
  };

  const totals = useMemo(() => {
    const t = { joined: 0, errors: 0, runs: 0, wins: 0 };
    for (const r of rows) {
      t.joined += r.joined; t.errors += r.errors; t.runs += r.runs;
      if (r.joinPct >= 80 && r.joined >= 3) t.wins += 1;
    }
    return t;
  }, [rows]);

  const th = (label: string, k: SortKey, extraClass = "") => (
    <th className={`px-2 py-1.5 text-left font-medium ${extraClass}`}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-primary" onClick={() => toggle(k)}>
        {label}
        <ArrowUpDown className={`h-3 w-3 ${sort === k ? "text-primary" : "text-muted-foreground/50"}`} />
      </button>
    </th>
  );

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 md:px-8">
          <Link to="/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button></Link>
          <h1 className="text-lg font-semibold">Bot success rate</h1>
          <div className="ml-auto flex items-center gap-2">
            <Input
              type="number" min={1} max={90} className="h-8 w-20"
              value={days} onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 30)))}
            />
            <span className="text-xs text-muted-foreground">days</span>
            <Button size="sm" variant="outline" onClick={() => q.refetch()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 md:px-8">
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Bots tracked" value={rows.length} />
          <StatCard label="Total joined" value={totals.joined} tone="success" />
          <StatCard label="Total errors" value={totals.errors} tone="danger" />
          <StatCard label="High performers" value={totals.wins} hint="≥80% join, ≥3 wins" tone="success" />
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <div className="text-sm font-medium">Seed default parser rules for a bot</div>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Adds ~8 curated regex rules (Success · Already registered · Banned · Rate-limited · Insufficient balance · Missing subscription · Referral counted · Balance) to Bot Parser. Idempotent — re-runs skip existing names.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="e.g. samplebot"
              value={seedBot}
              onChange={(e) => setSeedBot(e.target.value)}
              className="max-w-xs"
            />
            <Button size="sm" onClick={seed}>Seed presets</Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border bg-muted/40 px-4 py-2 text-sm font-medium">
            Per-bot rollup (last {days}d)
          </div>
          {q.isLoading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No data yet. Add referral links, run bot flows, or seed parser presets above.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/20 text-muted-foreground">
                  <tr>
                    {th("Bot", "bot")}
                    {th("Join %", "joinPct")}
                    {th("Joined", "joined")}
                    {th("Errors", "errors")}
                    {th("Runs", "runs")}
                    {th("Avg time", "avgSec")}
                    {th("✓ success", "class_success")}
                    {th("✕ error", "class_error")}
                    {th("Last run", "lastRunAt")}
                    <th className="px-2 py-1.5 text-left font-medium">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.bot} className="border-t border-border/50 hover:bg-muted/20">
                      <td className="px-2 py-1.5 font-mono">
                        @{r.bot}
                        {r.joinPct >= 80 && r.joined >= 3 && (
                          <Trophy className="ml-1 inline h-3 w-3 text-amber-500" aria-label="High performer" />
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className={
                          r.joinPct >= 80 ? "text-emerald-500 font-medium" :
                          r.joinPct >= 50 ? "text-amber-500" :
                          r.joinPct > 0 ? "text-orange-500" : "text-muted-foreground"
                        }>{r.joinPct}%</span>
                      </td>
                      <td className="px-2 py-1.5 text-emerald-500">{r.joined}</td>
                      <td className="px-2 py-1.5 text-destructive">{r.errors}</td>
                      <td className="px-2 py-1.5">{r.runs}</td>
                      <td className="px-2 py-1.5 font-mono text-muted-foreground">
                        {r.avgSec == null ? "—" : r.avgSec < 60 ? `${r.avgSec}s` : `${Math.round(r.avgSec / 60)}m`}
                      </td>
                      <td className="px-2 py-1.5 text-emerald-500">{r.class_success || "—"}</td>
                      <td className="px-2 py-1.5 text-destructive">{r.class_error || "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-muted-foreground">
                        {r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : "—"}
                      </td>
                      <td className="max-w-[28ch] truncate px-2 py-1.5 text-destructive" title={r.lastError ?? ""}>
                        {r.lastError ? (
                          <span className="inline-flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3 shrink-0" /> {r.lastError}
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          <strong>How it works:</strong> Join % comes from referral joins (joined ÷ joined+errors+pending). Success/Error counts come from Bot Parser results labelled with a classification. Runs and Avg time come from Bot Flow action runs completed in the window.
        </p>
      </div>
    </main>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "success" | "danger" }) {
  const color =
    tone === "success" ? "text-emerald-500" :
    tone === "danger" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}