import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { requireAdminBeforeLoad } from "@/lib/access-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AccountRangeControls, pickRange } from "@/components/AccountRangeControls";
import { Loader2, Send, Square, Clock, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/join-requests")({
  beforeLoad: requireAdminBeforeLoad,
  head: () => ({
    meta: [
      { title: "Bulk Join Requests — TeleManager Pro" },
      { name: "description", content: "Send bulk join requests to approval-required private Telegram channels with real-time status tracking and diagnostics." },
    ],
  }),
  component: JoinRequestsPage,
});

type Status = "pending" | "requested" | "accepted" | "already" | "failed";
type Row = {
  accountId: string;
  target: string;
  status: Status;
  code?: string | null;
  hint?: string | null;
  approval?: boolean;
  message?: string;
  canonical?: string | null;
  path?: string;
};

const STATUS_STYLE: Record<Status, { icon: any; cls: string; label: string }> = {
  pending:   { icon: Clock,        cls: "border-amber-500/30 bg-amber-500/5",   label: "Pending" },
  requested: { icon: Send,         cls: "border-blue-500/30 bg-blue-500/5",     label: "Requested" },
  accepted:  { icon: CheckCircle2, cls: "border-green-500/30 bg-green-500/5",   label: "Accepted" },
  already:   { icon: CheckCircle2, cls: "border-emerald-500/30 bg-emerald-500/5", label: "Already member" },
  failed:    { icon: XCircle,      cls: "border-red-500/30 bg-red-500/5",       label: "Failed" },
};

function JoinRequestsPage() {
  const listFn = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listFn() });
  const accounts = accountsQ.data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetsText, setTargetsText] = useState("");
  const [delay, setDelay] = useState(2000);
  const [parallel, setParallel] = useState(3);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const abortRef = useRef<AbortController | null>(null);

  const targets = useMemo(
    () => Array.from(new Set(targetsText.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean))),
    [targetsText],
  );

  const approvalCount = useMemo(
    () => targets.filter((t) => /^\+/.test(t.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, ""))
      || /joinchat\//i.test(t)).length,
    [targets],
  );

  const allChecked = selected.size > 0 && selected.size === accounts.length;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(accounts.map((a) => a.id)));
  const toggle = (id: string) => {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };

  const rowsList = Object.values(rows);
  const counts = {
    total: rowsList.length,
    pending: rowsList.filter((r) => r.status === "pending").length,
    requested: rowsList.filter((r) => r.status === "requested").length,
    accepted: rowsList.filter((r) => r.status === "accepted" || r.status === "already").length,
    failed: rowsList.filter((r) => r.status === "failed").length,
  };

  const canRun = selected.size > 0 && targets.length > 0 && !busy;

  const stop = () => abortRef.current?.abort();

  const run = async () => {
    if (!canRun) return;
    setRows({});
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const res = await fetch("/api/public/join-requests-stream", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          accountIds: Array.from(selected),
          targets,
          perAccountDelayMs: delay,
          parallelAccounts: Math.min(parallel, 20),
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Stream failed: ${res.status} ${await res.text().catch(() => "")}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const evt of events) {
          const lines = evt.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;
          const name = eventLine.slice(7).trim();
          let payload: any;
          try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (name === "update") {
            setRows((cur) => ({
              ...cur,
              [`${payload.accountId}::${payload.target}`]: payload as Row,
            }));
          } else if (name === "end") {
            if (payload.error) toast.error(payload.error);
            else if (payload.aborted) toast.info("Stopped.");
            else toast.success("Done.");
          }
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") toast.info("Stopped.");
      else toast.error(e?.message || "Failed");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Send className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Bulk Join Requests</h1>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-xs">
        <AlertCircle className="h-4 w-4 shrink-0 text-blue-500" />
        <div>
          Paste any Telegram links — approval-required (<code>t.me/+…</code>), public (<code>@username</code>, <code>t.me/x</code>),
          or invite hashes. Public links join immediately; approval links send a real join request that admins must approve.
          Live status per (account × link) with detailed diagnostics.
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Links</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label className="text-xs">One per line (also accepts comma/space separated).</Label>
              <Textarea
                rows={8}
                value={targetsText}
                onChange={(e) => setTargetsText(e.target.value)}
                placeholder={"https://t.me/+AbCdEfGhIjKlMnOp\nhttps://t.me/joinchat/xxxxx\n@publicchannel"}
                className="font-mono text-xs"
              />
              <div className="text-xs text-muted-foreground">
                {targets.length} link(s) — {approvalCount} approval-required
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Per-account delay (ms)</Label>
                  <Input type="number" min={0} max={60000} step={100}
                    value={delay}
                    onChange={(e) => setDelay(Math.max(0, Number(e.target.value) || 0))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Parallel accounts (max 20)</Label>
                  <Input type="number" min={1} max={20}
                    value={parallel}
                    onChange={(e) => setParallel(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
                </div>
              </div>
            </CardContent>
          </Card>

          {rowsList.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex flex-wrap gap-2 items-center">
                  <span>Live status — {counts.total}</span>
                  <span className="rounded bg-amber-500/15 px-1.5 text-amber-500">Pending {counts.pending}</span>
                  <span className="rounded bg-blue-500/15 px-1.5 text-blue-500">Requested {counts.requested}</span>
                  <span className="rounded bg-green-500/15 px-1.5 text-green-500">OK {counts.accepted}</span>
                  <span className="rounded bg-red-500/15 px-1.5 text-red-500">Failed {counts.failed}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-[420px] space-y-1 overflow-auto text-xs">
                  {rowsList.map((r, i) => {
                    const acc = accounts.find((a) => a.id === r.accountId);
                    const who = acc?.first_name || acc?.username || acc?.phone || r.accountId.slice(0, 8);
                    const s = STATUS_STYLE[r.status];
                    const Icon = s.icon;
                    return (
                      <div key={i} className={"flex flex-wrap items-center gap-2 rounded border px-2 py-1 " + s.cls}>
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-[110px] truncate font-medium">{who}</span>
                        <span className="min-w-[180px] max-w-[280px] truncate font-mono">{r.target}</span>
                        <span className="rounded bg-background/60 px-1.5 text-[10px] uppercase tracking-wide">{s.label}</span>
                        {r.code && <span className="rounded bg-background/60 px-1.5 text-[10px] font-mono">{r.code}</span>}
                        <span className="ml-auto min-w-[140px] max-w-[380px] truncate text-muted-foreground text-right" title={r.hint || r.message || ""}>
                          {r.hint || r.message}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Accounts ({selected.size} selected)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <Button size="sm" variant="outline" onClick={toggleAll}>
                {allChecked ? "Clear all" : "Select all"}
              </Button>
              <span className="text-muted-foreground">{accounts.length} total</span>
            </div>

            <AccountRangeControls
              total={accounts.length}
              onApply={(s, e, order) => {
                const picked = pickRange(accounts, s, e, order).map((a) => a.id);
                setSelected(new Set(picked));
              }}
            />

            <div className="max-h-[420px] space-y-1 overflow-auto rounded-md border border-border p-2">
              {accounts.map((a, i) => {
                const who = a.first_name || a.username || a.phone || a.id.slice(0, 8);
                return (
                  <label key={a.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent">
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggle(a.id)} />
                    <span className="w-5 text-muted-foreground">{i + 1}</span>
                    <span className="truncate">{who}</span>
                  </label>
                );
              })}
            </div>

            {busy ? (
              <Button className="w-full" variant="destructive" onClick={stop}>
                <Square className="mr-1 h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button className="w-full" disabled={!canRun} onClick={run}>
                {busy ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Sending…</>) : (
                  <><Send className="mr-1 h-4 w-4" /> Send join requests ({selected.size} × {targets.length})</>
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}