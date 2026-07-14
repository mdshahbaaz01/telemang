import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import {
  listReferralLinks, upsertReferralLink, deleteReferralLink,
  listReferralJoins, joinReferralFromAccounts, refreshReferralBalances,
  summarizeReferralsByBot, listBotFlowHistory, listBotFlowRunLogs,
} from "@/lib/referrals.functions";
import { listInlineButtonClicks } from "@/lib/button-clicks.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, Plus, Trash2, Play, RefreshCw, Download, ChevronDown, ChevronRight, Bot, MessageCircle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { chatViewer } from "@/components/chat/chat-viewer-store";
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

export const Route = createFileRoute("/_authenticated/referrals")({
  beforeLoad: requireAdminBeforeLoad,
  component: () => <AdminGate><Page /></AdminGate>,
});

function Page() {
  const listFn = useServerFn(listReferralLinks);
  const upsertFn = useServerFn(upsertReferralLink);
  const delFn = useServerFn(deleteReferralLink);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["referral-links"], queryFn: () => listFn() });

  const [form, setForm] = useState({ link: "", note: "", balance_field: "" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const save = async () => {
    if (!form.link) return toast.error("Paste a t.me referral link");
    try {
      await upsertFn({ data: { link: form.link, note: form.note || null, balance_field: form.balance_field || null } });
      setForm({ link: "", note: "", balance_field: "" });
      qc.invalidateQueries({ queryKey: ["referral-links"] });
      toast.success("Saved");
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 md:px-8">
          <Link to="/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button></Link>
          <h1 className="text-lg font-semibold">Referral tracker</h1>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 md:px-8">
        <BotSummaryPanel />
        <BotFlowHistoryPanel />

        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-3 font-semibold">Add referral link</h3>
          <div className="grid gap-2 md:grid-cols-4">
            <Input placeholder="https://t.me/somebot?start=REF" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} className="md:col-span-2" />
            <Input placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <div className="flex gap-2">
              <Input placeholder="Balance field name" value={form.balance_field} onChange={(e) => setForm({ ...form, balance_field: e.target.value })} />
              <Button onClick={save}><Plus className="mr-1 h-4 w-4" />Save</Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Balance field must match a field_name from Bot Parser rules to auto-refresh balances.</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border p-3 font-semibold">Links ({q.data?.length ?? 0})</div>
            <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
              {(q.data ?? []).map((l: any) => (
                <button
                  key={l.id}
                  onClick={() => setSelectedId(l.id)}
                  className={`flex w-full items-start justify-between gap-2 p-3 text-left ${selectedId === l.id ? "bg-muted/40" : ""}`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">@{l.bot_username}</div>
                    <div className="truncate text-xs text-muted-foreground">{l.note || l.base_link}</div>
                    <div className="truncate text-xs text-muted-foreground">ref: {l.my_ref_code || "—"}</div>
                  </div>
                  <span onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm("Delete link and all its joins?")) return;
                    await delFn({ data: { id: l.id } });
                    if (selectedId === l.id) setSelectedId(null);
                    qc.invalidateQueries({ queryKey: ["referral-links"] });
                  }}><Trash2 className="h-4 w-4 text-destructive" /></span>
                </button>
              ))}
              {!q.data?.length && <div className="p-3 text-sm text-muted-foreground">Paste a link above.</div>}
            </div>
          </div>
          <div>{selectedId ? <JoinsPanel linkId={selectedId} /> : <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">Pick a link to manage joins →</div>}</div>
        </div>
      </div>
    </main>
  );
}

function JoinsPanel({ linkId }: { linkId: string }) {
  const listJoins = useServerFn(listReferralJoins);
  const listAcc = useServerFn(listAccounts);
  const joinFn = useServerFn(joinReferralFromAccounts);
  const refreshFn = useServerFn(refreshReferralBalances);
  const qc = useQueryClient();
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const joins = useQuery({ queryKey: ["referral-joins", linkId], queryFn: () => listJoins({ data: { referral_link_id: linkId } }) });
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!ids.size) return toast.error("Pick accounts to join");
    setBusy(true);
    try {
      const r = await joinFn({ data: { referral_link_id: linkId, accountIds: [...ids] } });
      const ok = r.results.filter((x) => x.ok).length;
      toast.success(`Joined ${ok} / ${r.results.length}`);
      qc.invalidateQueries({ queryKey: ["referral-joins", linkId] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const refresh = async () => {
    try {
      const r = await refreshFn({ data: { referral_link_id: linkId } });
      toast.success(`Updated ${r.updated}${(r as any).note ? ` — ${(r as any).note}` : ""}`);
      qc.invalidateQueries({ queryKey: ["referral-joins", linkId] });
    } catch (e) { toast.error((e as Error).message); }
  };

  const nameFor = (id: string) => {
    const a = accs.data?.find((x: any) => x.id === id);
    return a ? (a.first_name || a.username || a.phone) : id.slice(0, 6);
  };
  const joinedIds = new Set((joins.data ?? []).map((j: any) => j.account_id));
  const unjoined = (accs.data ?? []).filter((a: any) => !joinedIds.has(a.id));
  const exportCsv = () => {
    if (!joins.data?.length) return;
    downloadCsv(`referral-joins-${linkId.slice(0, 8)}.csv`, [
      ["account", "account_id", "status", "joined_at", "last_balance_numeric", "last_balance_text", "last_checked_at", "last_error"],
      ...joins.data.map((j: any) => [nameFor(j.account_id), j.account_id, j.status, j.joined_at, j.last_balance_numeric, j.last_balance_text, j.last_checked_at, j.last_error]),
    ]);
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">Accounts NOT yet joined ({unjoined.length})</div>
          <Button size="sm" variant="ghost" onClick={() => setIds(new Set(unjoined.map((a: any) => a.id)))}>Select all</Button>
        </div>
        <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {unjoined.map((a: any) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded border border-border px-2 py-1 text-xs">
              <Checkbox checked={ids.has(a.id)} onCheckedChange={() => { const n = new Set(ids); n.has(a.id) ? n.delete(a.id) : n.add(a.id); setIds(n); }} />
              <span>{a.first_name || a.username || a.phone}</span>
            </label>
          ))}
          {!unjoined.length && <span className="text-xs text-muted-foreground">All accounts joined.</span>}
        </div>
        <div className="mt-2 flex gap-2">
          <Button onClick={run} disabled={busy}><Play className="mr-1 h-4 w-4" />{busy ? "Joining…" : `Join with ${ids.size} accounts`}</Button>
          <Button variant="outline" onClick={refresh}><RefreshCw className="mr-1 h-4 w-4" />Refresh balances</Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border p-3">
          <span className="font-semibold">Joins ({joins.data?.length ?? 0})</span>
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!joins.data?.length}>
            <Download className="mr-1 h-4 w-4" />CSV
          </Button>
        </div>
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-left"><tr>
            <th className="p-2">Account</th><th className="p-2">Status</th><th className="p-2">Joined</th><th className="p-2">Balance</th><th className="p-2">Last checked</th><th className="p-2">Error</th>
          </tr></thead>
          <tbody>
            {(joins.data ?? []).map((j: any) => (
              <tr key={j.id} className="border-t border-border">
                <td className="p-2">{nameFor(j.account_id)}</td>
                <td className="p-2">{j.status}</td>
                <td className="p-2">{j.joined_at ? new Date(j.joined_at).toLocaleString() : "—"}</td>
                <td className="p-2 font-mono">{j.last_balance_text ?? j.last_balance_numeric ?? "—"}</td>
                <td className="p-2">{j.last_checked_at ? new Date(j.last_checked_at).toLocaleString() : "—"}</td>
                <td className="p-2 text-destructive">{j.last_error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!joins.data?.length && <div className="p-3 text-sm text-muted-foreground">No joins yet.</div>}
      </div>
    </div>
  );
}

function BotSummaryPanel() {
  const fn = useServerFn(summarizeReferralsByBot);
  const q = useQuery({ queryKey: ["referrals-by-bot"], queryFn: () => fn() });
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (bot: string) => {
    const n = new Set(open); n.has(bot) ? n.delete(bot) : n.add(bot); setOpen(n);
  };

  const exportCsv = () => {
    const rows: (string | number | null)[][] = [["bot_username", "account", "account_id", "status", "joined_at", "ref_code", "balance"]];
    for (const b of q.data ?? []) {
      for (const a of b.accounts) {
        rows.push([b.bot_username, a.name, a.account_id, a.status, a.joined_at, a.ref_code, a.balance_text ?? a.balance_numeric]);
      }
    }
    downloadCsv("referrals-by-bot.csv", rows);
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="font-semibold">By bot ({q.data?.length ?? 0})</span>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={!q.data?.length}>
          <Download className="mr-1 h-4 w-4" />CSV
        </Button>
      </div>
      {q.isLoading && <div className="p-3 text-sm text-muted-foreground">Loading…</div>}
      <div className="divide-y divide-border">
        {(q.data ?? []).map((b) => {
          const isOpen = open.has(b.bot_username);
          return (
            <div key={b.bot_username}>
              <button
                onClick={() => toggle(b.bot_username)}
                className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/30"
              >
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <span className="text-sm font-medium">@{b.bot_username}</span>
                <span className="ml-auto flex items-center gap-3 text-xs">
                  <span className="text-muted-foreground">{b.links} link{b.links === 1 ? "" : "s"}</span>
                  <span className="rounded bg-green-500/15 px-2 py-0.5 text-green-600 dark:text-green-400">{b.joined} joined</span>
                  {b.errors > 0 && <span className="rounded bg-destructive/15 px-2 py-0.5 text-destructive">{b.errors} err</span>}
                  {b.pending > 0 && <span className="rounded bg-yellow-500/15 px-2 py-0.5 text-yellow-600 dark:text-yellow-400">{b.pending} pending</span>}
                  {b.totalBalance > 0 && <span className="text-muted-foreground">Σ {b.totalBalance.toLocaleString()}</span>}
                </span>
              </button>
              {isOpen && (
                <div className="overflow-x-auto border-t border-border bg-muted/10">
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="p-2">Account</th>
                        <th className="p-2">Account ID</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Joined at</th>
                        <th className="p-2">Ref code</th>
                        <th className="p-2">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.accounts.length === 0 && (
                        <tr><td className="p-2 text-muted-foreground" colSpan={6}>No joins yet for this bot.</td></tr>
                      )}
                      {b.accounts.map((a, i) => (
                        <tr key={`${a.account_id}-${i}`} className="border-t border-border">
                          <td className="p-2">{a.name}</td>
                          <td className="p-2 font-mono text-[10px] text-muted-foreground">{a.account_id.slice(0, 8)}…</td>
                          <td className="p-2">{a.status}</td>
                          <td className="p-2">{a.joined_at ? new Date(a.joined_at).toLocaleString() : "—"}</td>
                          <td className="p-2 font-mono">{a.ref_code ?? "—"}</td>
                          <td className="p-2 font-mono">{a.balance_text ?? a.balance_numeric ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
        {q.data && q.data.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">Add a referral link and run "Join with accounts" to see per-bot stats here.</div>
        )}
      </div>
    </div>
  );
}

function BotFlowHistoryPanel() {
  const listFn = useServerFn(listBotFlowHistory);
  const logsFn = useServerFn(listBotFlowRunLogs);
  const clicksFn = useServerFn(listInlineButtonClicks);
  const q = useQuery({ queryKey: ["botflow-history"], queryFn: () => listFn(), refetchInterval: 15000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const logsQ = useQuery({
    queryKey: ["botflow-run-logs", openId],
    queryFn: () => logsFn({ data: { run_id: openId! } }),
    enabled: !!openId,
  });
  const clicksQ = useQuery({
    queryKey: ["botflow-run-clicks", openId],
    queryFn: () => clicksFn({ data: { runId: openId!, limit: 100 } }),
    enabled: !!openId,
  });

  const logsByAcc = new Map<string, { level: string; message: string; created_at: string }>();
  for (const l of logsQ.data ?? []) {
    logsByAcc.set(l.account_id ?? "?", { level: l.level, message: l.message, created_at: l.created_at });
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="flex items-center gap-2 font-semibold"><Bot className="h-4 w-4" /> Bot Flow history ({q.data?.length ?? 0})</span>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()}><RefreshCw className="mr-1 h-3.5 w-3.5" />Refresh</Button>
      </div>
      {q.isLoading && <div className="p-3 text-sm text-muted-foreground">Loading…</div>}
      <div className="divide-y divide-border max-h-[520px] overflow-y-auto">
        {(q.data ?? []).map((run) => {
          const isOpen = openId === run.id;
          const badge =
            run.status === "done" ? "bg-green-500/15 text-green-600 dark:text-green-400"
            : run.status === "error" ? "bg-destructive/15 text-destructive"
            : run.status === "stopped" ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400"
            : "bg-blue-500/15 text-blue-600 dark:text-blue-400";
          return (
            <div key={run.id}>
              <button
                onClick={() => setOpenId(isOpen ? null : run.id)}
                className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/30"
              >
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">@{run.bot || "unknown"}</span>
                    {run.startParam && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">start={run.startParam}</span>}
                    <span className={`rounded px-2 py-0.5 text-[10px] ${badge}`}>{run.status}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {new Date(run.created_at).toLocaleString()} · {run.accounts.length} account(s) · {run.steps.length} step(s)
                  </div>
                </div>
                {run.link && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); window.open(run.link!, "_blank"); }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                    title="Open link"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </span>
                )}
              </button>
              {isOpen && (
                <div className="border-t border-border bg-muted/10 p-3">
                  {run.accounts.length === 0 && (
                    <div className="text-xs text-muted-foreground">No accounts recorded for this run.</div>
                  )}
                  <div className="grid gap-2 md:grid-cols-2">
                    {run.accounts.map((a) => {
                      const log = logsByAcc.get(a.account_id);
                      const lvlColor =
                        log?.level === "error" ? "text-destructive"
                        : log?.level === "success" ? "text-green-600 dark:text-green-400"
                        : log?.level === "warn" ? "text-yellow-600 dark:text-yellow-400"
                        : "text-muted-foreground";
                      return (
                        <div key={a.account_id} className="flex items-center gap-2 rounded border border-border p-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{a.name}</div>
                            <div className={`truncate text-[11px] ${lvlColor}`}>
                              {log ? log.message : "No log entry"}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => chatViewer.open(run.bot, a.account_id)}
                            title="Open bot chat for this account"
                            disabled={!run.bot}
                          >
                            <MessageCircle className="mr-1 h-3.5 w-3.5" />Chat
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                  {run.steps.length > 0 && (
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Steps sent ({run.steps.length})</summary>
                      <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                        {run.steps.map((s, i) => (<li key={i} className="font-mono break-all">{s}</li>))}
                      </ol>
                    </details>
                  )}
                  <details className="mt-3 text-xs" open={(clicksQ.data?.length ?? 0) > 0}>
                    <summary className="cursor-pointer text-muted-foreground">
                      Button clicks ({clicksQ.data?.length ?? 0})
                    </summary>
                    {clicksQ.isLoading ? (
                      <div className="mt-1 text-muted-foreground">Loading…</div>
                    ) : (clicksQ.data?.length ?? 0) === 0 ? (
                      <div className="mt-1 text-muted-foreground">No button clicks recorded for this run.</div>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {clicksQ.data!.map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center gap-2 rounded border border-border/50 bg-background px-2 py-1">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              {new Date(c.created_at).toLocaleTimeString()}
                            </span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">{c.button_kind}</span>
                            <span className={
                              c.result_status === "error"
                                ? "text-destructive"
                                : c.result_alert
                                  ? "text-yellow-600 dark:text-yellow-400"
                                  : ""
                            }>
                              {c.button_label ?? "(no label)"}
                            </span>
                            {c.result_message && (
                              <span className="truncate text-muted-foreground">→ {c.result_message}</span>
                            )}
                            {c.result_url && (
                              <a href={c.result_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                                <ExternalLink className="inline h-3 w-3" />
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                </div>
              )}
            </div>
          );
        })}
        {q.data && q.data.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">No Bot Flow runs yet. Runs from the Bot Flow page will appear here automatically.</div>
        )}
      </div>
    </div>
  );
}