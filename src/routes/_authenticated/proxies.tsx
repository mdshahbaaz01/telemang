import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Globe, Loader2, Trash2, Zap, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader } from "@/components/ui/loader";
import {
  listAccountProxies,
  setAccountProxy,
  clearAccountProxy,
  bulkSetAccountProxy,
  testAccountProxy,
} from "@/lib/proxy.functions";
import { AccountRangeControls, pickRange } from "@/components/AccountRangeControls";
import { AccountIdPaste } from "@/components/AccountIdPaste";

export const Route = createFileRoute("/_authenticated/proxies")({
  head: () => ({ meta: [{ title: "Proxies · TeleManager Pro" }] }),
  component: ProxiesPage,
});

type ProxyType = "socks5" | "socks4" | "mtproxy";
type Draft = { type: ProxyType; host: string; port: number; user?: string; pass?: string; secret?: string };

const EMPTY: Draft = { type: "socks5", host: "", port: 1080, user: "", pass: "" };

function ProxiesPage() {
  const listFn = useServerFn(listAccountProxies);
  const setFn = useServerFn(setAccountProxy);
  const clearFn = useServerFn(clearAccountProxy);
  const bulkFn = useServerFn(bulkSetAccountProxy);
  const testFn = useServerFn(testAccountProxy);

  const q = useQuery({ queryKey: ["accountProxies"], queryFn: () => listFn() });
  const rows = q.data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDraft, setBulkDraft] = useState<Draft>(EMPTY);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const draftFor = (id: string): Draft => drafts[id] ?? EMPTY;
  const updateDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...draftFor(id), ...patch } }));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const buildProxy = (d: Draft) => {
    if (!d.host || !d.port) throw new Error("host and port required");
    if (d.type === "mtproxy") {
      if (!d.secret) throw new Error("MTProxy secret required");
      return { type: "mtproxy" as const, host: d.host, port: d.port, secret: d.secret };
    }
    return { type: d.type, host: d.host, port: d.port, user: d.user || undefined, pass: d.pass || undefined };
  };

  const save = async (id: string) => {
    try {
      setBusyId(id);
      const proxy = buildProxy(draftFor(id));
      await setFn({ data: { accountId: id, proxy } });
      toast.success("Proxy saved");
      await q.refetch();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusyId(null); }
  };

  const clear = async (id: string) => {
    try {
      setBusyId(id);
      await clearFn({ data: { accountId: id } });
      toast.success("Proxy removed");
      await q.refetch();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusyId(null); }
  };

  const test = async (id: string) => {
    try {
      setBusyId(id);
      setTestResult((r) => ({ ...r, [id]: "Testing…" }));
      const res = await testFn({ data: { accountId: id } });
      setTestResult((r) => ({
        ...r,
        [id]: res.ok ? `OK · ${res.ms}ms${res.me?.username ? " · @" + res.me.username : ""}` : `FAIL · ${res.error}`,
      }));
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: `FAIL · ${(e as Error).message}` }));
    } finally { setBusyId(null); }
  };

  const applyBulk = async (clearAll: boolean) => {
    if (!selected.size) return toast.error("Select at least one account");
    try {
      const proxy = clearAll ? null : buildProxy(bulkDraft);
      const res = await bulkFn({ data: { accountIds: Array.from(selected), proxy } });
      toast.success(`${clearAll ? "Cleared" : "Applied"} to ${res.updated} account(s)`);
      await q.refetch();
    } catch (e) { toast.error((e as Error).message); }
  };

  const withProxy = useMemo(() => rows.filter((r) => r.hasProxy).length, [rows]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Proxies</h1>
        <span className="text-xs text-muted-foreground ml-2">
          I have approved the plan
        </span>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Route each account through its own SOCKS5/4 or MTProxy tunnel to isolate device fingerprints and avoid IP-based bans.
        Credentials are encrypted at rest; WSS is auto-disabled when a proxy is set (raw TCP through the tunnel).
      </p>

      {/* Bulk apply */}
      <div className="rounded-md border border-border p-3 bg-card space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Bulk apply to selected ({selected.size})</Label>
          <div className="flex flex-wrap items-center gap-1">
            <AccountRangeControls
              total={rows.length}
              onApply={(s, e, order) => setSelected(new Set(pickRange(rows, s, e, order).map((r) => r.id)))}
            />
            <Button size="sm" variant="outline" className="h-8" onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>Select all</Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelected(new Set())}>Deselect all</Button>
          </div>
        </div>
        <AccountIdPaste
          accounts={rows.map((r: any) => ({
            id: r.id,
            phone: r.phone ?? r.label,
            username: r.username ?? r.label,
            first_name: r.first_name ?? r.label,
            telegram_user_id: r.telegram_user_id ?? null,
          }))}
          onSelect={(ids) => setSelected((prev) => new Set([...prev, ...ids]))}
        />
        <ProxyForm value={bulkDraft} onChange={setBulkDraft} />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => applyBulk(false)}><Save className="h-3 w-3 mr-1" />Apply to selected</Button>
          <Button size="sm" variant="outline" onClick={() => applyBulk(true)}><Trash2 className="h-3 w-3 mr-1" />Clear on selected</Button>
        </div>
      </div>

      {/* Per-account table */}
      <div className="rounded-md border border-border bg-card">
        {q.isLoading ? <div className="p-6"><Loader /></div> : rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground text-center">No accounts.</div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r, i) => {
              const d = draftFor(r.id);
              return (
                <div key={r.id} className="p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    <span className="text-xs text-muted-foreground">#{i + 1}</span>
                    <span className="text-sm font-medium truncate">{r.label}</span>
                    {r.hasProxy ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">{r.summary}</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">direct</span>
                    )}
                    {testResult[r.id] && (
                      <span className={`text-[10px] ml-auto ${testResult[r.id].startsWith("OK") ? "text-green-500" : testResult[r.id].startsWith("Testing") ? "text-muted-foreground" : "text-destructive"}`}>
                        {testResult[r.id]}
                      </span>
                    )}
                  </div>
                  <ProxyForm value={d} onChange={(v) => updateDraft(r.id, v)} />
                  <div className="flex gap-2 flex-wrap">
                    <Button size="sm" onClick={() => save(r.id)} disabled={busyId === r.id}>
                      {busyId === r.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
                      Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => test(r.id)} disabled={busyId === r.id || !r.hasProxy}>
                      <Zap className="h-3 w-3 mr-1" />Test
                    </Button>
                    {r.hasProxy && (
                      <Button size="sm" variant="ghost" onClick={() => clear(r.id)} disabled={busyId === r.id}>
                        <Trash2 className="h-3 w-3 mr-1" />Clear
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ProxyForm({ value, onChange }: { value: Draft; onChange: (v: Draft) => void }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
      <div>
        <Label className="text-[11px]">Type</Label>
        <select
          className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          value={value.type}
          onChange={(e) => onChange({ ...value, type: e.target.value as ProxyType })}
        >
          <option value="socks5">SOCKS5</option>
          <option value="socks4">SOCKS4</option>
          <option value="mtproxy">MTProxy</option>
        </select>
      </div>
      <div className="col-span-2">
        <Label className="text-[11px]">Host</Label>
        <Input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} placeholder="1.2.3.4" />
      </div>
      <div>
        <Label className="text-[11px]">Port</Label>
        <Input type="number" min={1} max={65535} value={value.port}
          onChange={(e) => onChange({ ...value, port: +e.target.value || 0 })} />
      </div>
      {value.type === "mtproxy" ? (
        <div className="col-span-2">
          <Label className="text-[11px]">Secret (hex)</Label>
          <Input value={value.secret ?? ""} onChange={(e) => onChange({ ...value, secret: e.target.value.trim() })} />
        </div>
      ) : (
        <>
          <div>
            <Label className="text-[11px]">User (opt)</Label>
            <Input value={value.user ?? ""} onChange={(e) => onChange({ ...value, user: e.target.value })} />
          </div>
          <div>
            <Label className="text-[11px]">Pass (opt)</Label>
            <Input type="password" value={value.pass ?? ""} onChange={(e) => onChange({ ...value, pass: e.target.value })} />
          </div>
        </>
      )}
    </div>
  );
}