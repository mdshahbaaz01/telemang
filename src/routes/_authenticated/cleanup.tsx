import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import { listDialogs } from "@/lib/cleanup.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, RefreshCw, Square, Play } from "lucide-react";

export const Route = createFileRoute("/_authenticated/cleanup")({
  component: () => (
    <AdminGate>
      <Cleanup />
    </AdminGate>
  ),
});

type Peer =
  | { kind: "user"; id: string; accessHash: string }
  | { kind: "channel"; id: string; accessHash: string }
  | { kind: "chat"; id: string };

type Dialog = {
  key: string;
  id: string;
  type: "user" | "bot" | "chat" | "channel" | "megagroup";
  title: string;
  username: string | null;
  peer: Peer;
};

type Action = "leave" | "block" | "deleteHistory" | "deletePersonal";

type LogEntry = {
  time: string;
  accountId?: string;
  kind: "info" | "ok" | "error";
  target?: string;
  message: string;
};

function Cleanup() {
  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 md:px-8">
          <Link to="/dashboard">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">Cleanup</h1>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 md:px-8">
        <Tabs defaultValue="chats">
          <TabsList>
            <TabsTrigger value="chats">Chats, Groups & Bots</TabsTrigger>
            <TabsTrigger value="personal">Personal Chats</TabsTrigger>
          </TabsList>
          <TabsContent value="chats" className="mt-4">
            <CleanupPanel mode="chats" />
          </TabsContent>
          <TabsContent value="personal" className="mt-4">
            <CleanupPanel mode="personal" />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function CleanupPanel({ mode }: { mode: "chats" | "personal" }) {
  const listAcc = useServerFn(listAccounts);
  const queryClient = useQueryClient();
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });

  const [accountIds, setAccountIds] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action>(mode === "personal" ? "deletePersonal" : "leave");
  const [query, setQuery] = useState("");
  const [selectedByAcc, setSelectedByAcc] = useState<Record<string, Set<string>>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [doneByAcc, setDoneByAcc] = useState<Record<string, { ok: number; fail: number }>>({});
  const abortRef = useRef<AbortController | null>(null);

  const toggleAccount = (id: string) => {
    setAccountIds((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const toggleAllAccounts = () => {
    const all = accountsQ.data ?? [];
    if (accountIds.size === all.length) setAccountIds(new Set());
    else setAccountIds(new Set(all.map((a) => a.id)));
  };

  const appendLog = useCallback((e: Omit<LogEntry, "time">) => {
    setLogs((prev) => {
      const next = [...prev, { ...e, time: new Date().toLocaleTimeString() }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const run = async () => {
    if (!accountIds.size) {
      toast.error("Pick at least one account");
      return;
    }
    const jobs: { accountId: string; targets: Dialog[] }[] = [];
    for (const id of accountIds) {
      const sel = selectedByAcc[id];
      const dialogs =
        (queryClient.getQueryData<Dialog[]>(["dialogs", id]) as Dialog[] | undefined) ?? [];
      const targets = dialogs.filter((d) => sel?.has(d.key));
      if (targets.length) jobs.push({ accountId: id, targets });
    }
    if (!jobs.length) {
      toast.error("Select at least one item in the account lists");
      return;
    }
    setLogs([]);
    setDoneByAcc({});
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("No session");
      const res = await fetch("/api/public/cleanup-stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action, jobs }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        throw new Error(`Stream failed (${res.status}): ${t}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const eventMatch = chunk.match(/^event: (.+)$/m);
          const dataMatch = chunk.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const ev = eventMatch[1];
          let payload: any = {};
          try { payload = JSON.parse(dataMatch[1]); } catch {}
          if (ev === "log") {
            appendLog({
              accountId: payload.accountId,
              kind: payload.kind ?? "info",
              target: payload.target,
              message: payload.message ?? "",
            });
          } else if (ev === "done") {
            setDoneByAcc((p) => ({ ...p, [payload.accountId]: { ok: payload.ok, fail: payload.fail } }));
            appendLog({
              accountId: payload.accountId,
              kind: "info",
              message: `Finished: ${payload.ok} ok / ${payload.fail} failed`,
            });
          } else if (ev === "end") {
            appendLog({ kind: "info", message: payload.aborted ? "Stopped." : "All accounts finished." });
          } else if (ev === "aborted") {
            appendLog({ kind: "info", message: payload.message ?? "Aborted." });
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        appendLog({ kind: "error", message: (e as Error).message });
        toast.error((e as Error).message);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    appendLog({ kind: "info", message: "Stop requested." });
  };

  const idsArr = Array.from(accountIds);

  return (
    <div className="space-y-4">
      {/* Accounts */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Accounts</h2>
          <Button variant="outline" size="sm" onClick={toggleAllAccounts}>
            {accountIds.size === (accountsQ.data?.length ?? 0) && (accountsQ.data?.length ?? 0) > 0
              ? "Deselect all"
              : "Select all"}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {(accountsQ.data ?? []).map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded border border-border p-2 text-sm">
              <Checkbox checked={accountIds.has(a.id)} onCheckedChange={() => toggleAccount(a.id)} />
              <div className="min-w-0">
                <div className="truncate">{a.first_name || a.username || a.phone}</div>
                <div className="truncate text-xs text-muted-foreground">{a.phone}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Action</label>
          {mode === "personal" ? (
            <Select value="deletePersonal" onValueChange={() => {}}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="deletePersonal">Delete personal chat (both sides)</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Select value={action} onValueChange={(v) => { setAction(v as Action); setSelectedByAcc({}); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="leave">Leave channels / groups</SelectItem>
                <SelectItem value="block">Block bot/user + delete both sides</SelectItem>
                <SelectItem value="deleteHistory">Delete history (my side)</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs text-muted-foreground">Search</label>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title or @username" />
        </div>
      </div>

      {/* Run / Stop */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={run} disabled={running || !accountIds.size} variant={action === "leave" ? "default" : "destructive"}>
          <Play className="mr-1 h-4 w-4" /> {running ? "Running…" : "Run on selected accounts"}
        </Button>
        <Button onClick={stop} disabled={!running} variant="outline">
          <Square className="mr-1 h-4 w-4" /> Stop
        </Button>
        {running && <span className="text-xs text-muted-foreground">Streaming live logs…</span>}
      </div>

      {/* Per-account columns */}
      {idsArr.length === 0 ? (
        <p className="text-sm text-muted-foreground">Pick one or more accounts above.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {idsArr.map((id) => (
            <AccountColumn
              key={id}
              accountId={id}
              account={accountsQ.data?.find((a) => a.id === id)}
              mode={mode}
              action={mode === "personal" ? "deletePersonal" : action}
              query={query}
              selected={selectedByAcc[id] ?? new Set()}
              setSelected={(next) => setSelectedByAcc((p) => ({ ...p, [id]: next }))}
              done={doneByAcc[id]}
              running={running}
            />
          ))}
        </div>
      )}

      {/* Live logs */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h3 className="font-semibold">Live logs</h3>
          <Button size="sm" variant="ghost" onClick={() => setLogs([])} disabled={!logs.length}>Clear</Button>
        </div>
        <ScrollArea className="h-72">
          <div className="p-3 font-mono text-xs">
            {logs.length === 0 ? (
              <p className="text-muted-foreground">No events yet. Run to see live progress.</p>
            ) : (
              logs.map((l, i) => {
                const acc = l.accountId ? (accountsQ.data?.find((a) => a.id === l.accountId)?.first_name || accountsQ.data?.find((a) => a.id === l.accountId)?.username || accountsQ.data?.find((a) => a.id === l.accountId)?.phone) : "";
                return (
                  <div key={i} className={l.kind === "error" ? "text-destructive" : l.kind === "ok" ? "text-foreground" : "text-muted-foreground"}>
                    <span className="opacity-60">[{l.time}]</span>{" "}
                    {acc && <span className="opacity-80">[{acc}]</span>}{" "}
                    {l.kind === "ok" ? "✓" : l.kind === "error" ? "✗" : "•"}{" "}
                    {l.target ? <span className="font-semibold">{l.target}</span> : null}{l.target ? " — " : ""}{l.message}
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function AccountColumn({
  accountId,
  account,
  mode,
  action,
  query,
  dialogs,
  selected,
  setSelected,
  done,
  running,
}: {
  accountId: string;
  account?: { first_name: string | null; username: string | null; phone: string } | undefined;
  mode: "chats" | "personal";
  action: Action;
  query: string;
  dialogs: ReturnType<typeof useQuery<Dialog[]>>;
  selected: Set<string>;
  setSelected: (n: Set<string>) => void;
  done?: { ok: number; fail: number };
  running: boolean;
}) {
  const filtered = useMemo(() => {
    const rows = (dialogs?.data ?? []) as Dialog[];
    return rows.filter((r) => {
      if (mode === "personal") {
        // personal chats = users (non-bot) with 1:1 kind
        if (r.type !== "user") return false;
      } else {
        if (action === "leave" && !["channel", "megagroup", "chat"].includes(r.type)) return false;
        if (action === "block" && !["user", "bot"].includes(r.type)) return false;
        // deleteHistory allows all
      }
      if (query) {
        const q = query.toLowerCase();
        return r.title.toLowerCase().includes(q) || (r.username?.toLowerCase().includes(q) ?? false);
      }
      return true;
    });
  }, [dialogs?.data, action, query, mode]);

  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.key));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map((r) => r.key)));
  };
  const toggle = (key: string) => {
    const n = new Set(selected);
    n.has(key) ? n.delete(key) : n.add(key);
    setSelected(n);
  };

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{account?.first_name || account?.username || account?.phone || accountId}</div>
          <div className="truncate text-xs text-muted-foreground">
            {selected.size} selected · {filtered.length} shown
            {done ? ` · ✓${done.ok} ✗${done.fail}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => dialogs?.refetch()} disabled={running}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={toggleAll} disabled={running || !filtered.length}>
            {allSelected ? "None" : "All"}
          </Button>
        </div>
      </div>
      <ScrollArea className="h-80">
        {dialogs?.isLoading ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : dialogs?.error ? (
          <p className="p-3 text-sm text-destructive">{(dialogs.error as Error).message}</p>
        ) : filtered.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((r) => (
              <label key={r.key} className="flex cursor-pointer items-center gap-2 p-2">
                <Checkbox checked={selected.has(r.key)} onCheckedChange={() => toggle(r.key)} disabled={running} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.type}{r.username ? ` · @${r.username}` : ""}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}