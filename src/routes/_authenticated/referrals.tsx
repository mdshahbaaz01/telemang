import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import {
  listReferralLinks, upsertReferralLink, deleteReferralLink,
  listReferralJoins, joinReferralFromAccounts, refreshReferralBalances,
} from "@/lib/referrals.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, Plus, Trash2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/referrals")({
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
        <div className="border-b border-border p-3 font-semibold">Joins ({joins.data?.length ?? 0})</div>
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