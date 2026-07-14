import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import {
  listParseRules, upsertParseRule, deleteParseRule,
  listParseResults, runParseScan,
} from "@/lib/bot-parser.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, Play, Trash2, Plus, Download } from "lucide-react";
import { toast } from "sonner";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
}

export const Route = createFileRoute("/_authenticated/bot-parser")({
  beforeLoad: requireAdminBeforeLoad,
  component: () => <AdminGate><Page /></AdminGate>,
});

function Page() {
  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 md:px-8">
          <Link to="/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button></Link>
          <h1 className="text-lg font-semibold">Bot response parser</h1>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 md:px-8">
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="scan">Run scan</TabsTrigger>
            <TabsTrigger value="results">Captured values</TabsTrigger>
          </TabsList>
          <TabsContent value="rules" className="mt-4"><RulesPanel /></TabsContent>
          <TabsContent value="scan" className="mt-4"><ScanPanel /></TabsContent>
          <TabsContent value="results" className="mt-4"><ResultsPanel /></TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function RulesPanel() {
  const listFn = useServerFn(listParseRules);
  const upsertFn = useServerFn(upsertParseRule);
  const delFn = useServerFn(deleteParseRule);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["parse-rules"], queryFn: () => listFn() });

  const [form, setForm] = useState({ name: "", bot_username: "", regex: "", field_name: "", unit: "" });

  const save = async () => {
    if (!form.name || !form.bot_username || !form.regex || !form.field_name) return toast.error("Fill all required fields");
    try {
      await upsertFn({ data: { rule: { ...form, unit: form.unit || null } } });
      setForm({ name: "", bot_username: "", regex: "", field_name: "", unit: "" });
      qc.invalidateQueries({ queryKey: ["parse-rules"] });
      toast.success("Rule saved");
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-3 font-semibold">Add rule</h3>
        <div className="grid gap-2 md:grid-cols-5">
          <Input placeholder="Name (e.g. Balance)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input placeholder="Bot @username" value={form.bot_username} onChange={(e) => setForm({ ...form, bot_username: e.target.value })} />
          <Input placeholder="Field name (balance)" value={form.field_name} onChange={(e) => setForm({ ...form, field_name: e.target.value })} />
          <Input placeholder="Unit (USD, coins…)" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          <Button onClick={save}><Plus className="mr-1 h-4 w-4" />Add</Button>
        </div>
        <Input className="mt-2 font-mono text-xs" placeholder="Regex — first capture group is used, e.g. Balance:\\s*([\\d.]+)" value={form.regex} onChange={(e) => setForm({ ...form, regex: e.target.value })} />
        <p className="mt-2 text-xs text-muted-foreground">
          Tip: use one capture group. Example: <code>Balance:\s*([\d,.]+)</code> or <code>Points:\s*(\d+)</code>
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border p-3 font-semibold">Rules ({q.data?.length ?? 0})</div>
        <div className="divide-y divide-border">
          {(q.data ?? []).map((r: any) => (
            <div key={r.id} className="flex items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{r.name} <span className="text-xs text-muted-foreground">@{r.bot_username} → {r.field_name}{r.unit ? ` (${r.unit})` : ""}</span></div>
                <code className="truncate text-xs text-muted-foreground">{r.regex}</code>
              </div>
              <Button size="sm" variant="ghost" onClick={async () => {
                if (!confirm("Delete this rule?")) return;
                await delFn({ data: { id: r.id } });
                qc.invalidateQueries({ queryKey: ["parse-rules"] });
              }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          ))}
          {!q.data?.length && <div className="p-3 text-sm text-muted-foreground">No rules yet. Add one above.</div>}
        </div>
      </div>
    </div>
  );
}

function ScanPanel() {
  const listAcc = useServerFn(listAccounts);
  const listRules = useServerFn(listParseRules);
  const runFn = useServerFn(runParseScan);
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const rules = useQuery({ queryKey: ["parse-rules"], queryFn: () => listRules() });
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [ruleIds, setRuleIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ scanned: number; captured: number; errors: any[] } | null>(null);
  const [n, setN] = useState(30);

  const run = async () => {
    if (!ids.size) return toast.error("Pick accounts");
    if (!ruleIds.size) return toast.error("Pick rules");
    setBusy(true); setResult(null);
    try {
      const r = await runFn({ data: { accountIds: [...ids], ruleIds: [...ruleIds], messagesPerBot: n } });
      setResult(r);
      toast.success(`Scanned ${r.scanned} msgs, captured ${r.captured}`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 text-sm font-semibold">Accounts ({ids.size})</div>
        <div className="flex flex-wrap gap-2">
          {(accs.data ?? []).map((a: any) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded border border-border px-2 py-1 text-xs">
              <Checkbox checked={ids.has(a.id)} onCheckedChange={() => { const n = new Set(ids); n.has(a.id) ? n.delete(a.id) : n.add(a.id); setIds(n); }} />
              <span>{a.first_name || a.username || a.phone}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 text-sm font-semibold">Rules ({ruleIds.size})</div>
        <div className="flex flex-wrap gap-2">
          {(rules.data ?? []).map((r: any) => (
            <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded border border-border px-2 py-1 text-xs">
              <Checkbox checked={ruleIds.has(r.id)} onCheckedChange={() => { const n = new Set(ruleIds); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setRuleIds(n); }} />
              <span>{r.name} <span className="text-muted-foreground">@{r.bot_username}</span></span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-xs text-muted-foreground">Messages per bot:</div>
        <Input type="number" min={1} max={200} value={n} onChange={(e) => setN(Number(e.target.value))} className="w-24" />
        <Button onClick={run} disabled={busy}><Play className="mr-1 h-4 w-4" /> {busy ? "Scanning…" : "Run scan"}</Button>
      </div>
      {result && (
        <div className="rounded border border-border bg-card p-3 text-xs">
          Scanned {result.scanned} messages, captured {result.captured}.
          {result.errors.length > 0 && (
            <ul className="mt-1 text-destructive">
              {result.errors.map((e, i) => <li key={i}>[{String(e.accountId).slice(0, 6)}] {e.message}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ResultsPanel() {
  const listFn = useServerFn(listParseResults);
  const listAcc = useServerFn(listAccounts);
  const q = useQuery({ queryKey: ["parse-results"], queryFn: () => listFn({ data: {} }) });
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const nameFor = (id: string) => {
    const a = accs.data?.find((x: any) => x.id === id);
    return a ? (a.first_name || a.username || a.phone) : id.slice(0, 6);
  };
  const exportCsv = () => {
    if (!q.data?.length) return;
    downloadCsv("bot-parse-results.csv", [
      ["captured_at", "account", "account_id", "bot_username", "field_name", "value_numeric", "value_text", "raw_text"],
      ...q.data.map((r: any) => [r.captured_at, nameFor(r.account_id), r.account_id, r.bot_username, r.field_name, r.value_numeric, r.value_text, r.raw_text]),
    ]);
  };
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="font-semibold">Captured values (latest 500)</span>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={!q.data?.length}>
          <Download className="mr-1 h-4 w-4" />CSV
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-left"><tr>
            <th className="p-2">When</th><th className="p-2">Account</th><th className="p-2">Bot</th><th className="p-2">Field</th><th className="p-2">Value</th>
          </tr></thead>
          <tbody>
            {(q.data ?? []).map((r: any) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-2 text-muted-foreground">{new Date(r.captured_at).toLocaleString()}</td>
                <td className="p-2">{nameFor(r.account_id)}</td>
                <td className="p-2">@{r.bot_username}</td>
                <td className="p-2">{r.field_name}</td>
                <td className="p-2 font-mono">{r.value_text ?? r.value_numeric}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!q.data?.length && <div className="p-3 text-sm text-muted-foreground">No captured values yet. Run a scan first.</div>}
      </div>
    </div>
  );
}