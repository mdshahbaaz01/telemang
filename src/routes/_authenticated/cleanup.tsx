import { Loader } from "@/components/ui/loader";
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
import { AccountIdPaste } from "@/components/AccountIdPaste";
import { AccountRangeControls, pickRange } from "@/components/AccountRangeControls";
import { Textarea } from "@/components/ui/textarea";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/cleanup")({
  beforeLoad: requireAdminBeforeLoad,
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

type Action =
  | "leave"
  | "block"
  | "deleteHistory"
  | "deletePersonal"
  | "mute"
  | "unmute"
  | "archive"
  | "unarchive"
  | "pin"
  | "unpin";

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
            <TabsTrigger value="chats">Chats & Groups</TabsTrigger>
            <TabsTrigger value="bots">Bots</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="personal">Personal Chats</TabsTrigger>
            <TabsTrigger value="links">Leave by link</TabsTrigger>
          </TabsList>
          <TabsContent value="chats" className="mt-4">
            <CleanupPanel mode="chats" kind="groups" />
          </TabsContent>
          <TabsContent value="bots" className="mt-4">
            <CleanupPanel mode="chats" kind="bots" />
          </TabsContent>
          <TabsContent value="users" className="mt-4">
            <CleanupPanel mode="chats" kind="users" />
          </TabsContent>
          <TabsContent value="personal" className="mt-4">
            <CleanupPanel mode="personal" />
          </TabsContent>
          <TabsContent value="links" className="mt-4">
            <LeaveByLinksPanel />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

type KindFilter = "groups" | "bots" | "users";
function CleanupPanel({ mode, kind }: { mode: "chats" | "personal"; kind?: KindFilter }) {
  return <CleanupPanelInner mode={mode} kind={kind} />;
}

function LeaveByLinksPanel() {
  const listAcc = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const [accountIds, setAccountIds] = useState<Set<string>>(new Set());
  const [linksText, setLinksText] = useState("");
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

  const parseLinks = (text: string) =>
    Array.from(
      new Set(
        text
          .split(/[\s,]+/)
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    );

  const run = async () => {
    if (!accountIds.size) return toast.error("Pick at least one account");
    const links = parseLinks(linksText);
    if (!links.length) return toast.error("Paste at least one link");
    setLogs([]);
    setDoneByAcc({});
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("No session");
      const jobs = Array.from(accountIds).map((accountId) => ({ accountId, targets: [], links }));
      const res = await fetch("/api/public/cleanup-stream", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "leaveByLinks", jobs }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status}): ${await res.text().catch(() => "")}`);
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
          const ev = chunk.match(/^event: (.+)$/m)?.[1];
          const dt = chunk.match(/^data: (.+)$/m)?.[1];
          if (!ev || !dt) continue;
          let payload: any = {};
          try { payload = JSON.parse(dt); } catch {}
          if (ev === "log") {
            appendLog({ accountId: payload.accountId, kind: payload.kind ?? "info", target: payload.target, message: payload.message ?? "" });
          } else if (ev === "done") {
            setDoneByAcc((p) => ({ ...p, [payload.accountId]: { ok: payload.ok, fail: payload.fail } }));
            appendLog({ accountId: payload.accountId, kind: "info", message: `Finished: ${payload.ok} ok / ${payload.fail} failed` });
          } else if (ev === "end") {
            appendLog({ kind: "info", message: payload.aborted ? "Stopped." : "All accounts finished." });
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
  const stop = () => { abortRef.current?.abort(); appendLog({ kind: "info", message: "Stop requested." }); };

  const linkCount = parseLinks(linksText).length;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Accounts</h2>
          <div className="flex flex-wrap items-center gap-2">
            <AccountRangeControls
              total={accountsQ.data?.length ?? 0}
              onApply={(s, e, order) => {
                const picked = pickRange(accountsQ.data ?? [], s, e, order).map((a) => a.id);
                setAccountIds(new Set(picked));
              }}
            />
            <Button variant="outline" size="sm" onClick={toggleAllAccounts}>
              {accountIds.size === (accountsQ.data?.length ?? 0) && (accountsQ.data?.length ?? 0) > 0 ? "Deselect all" : "Select all"}
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {(accountsQ.data ?? []).map((a, i) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded border border-border p-2 text-sm">
              <Checkbox checked={accountIds.has(a.id)} onCheckedChange={() => toggleAccount(a.id)} />
              <div className="min-w-0">
                <div className="truncate"><span className="text-muted-foreground mr-1">#{i + 1}</span>{a.first_name || a.username || a.phone}</div>
                <div className="truncate text-xs text-muted-foreground">{a.phone}</div>
              </div>
            </label>
          ))}
        </div>
        <AccountIdPaste
          className="mt-3"
          accounts={accountsQ.data ?? []}
          onSelect={(ids) => setAccountIds((prev) => { const n = new Set(prev); for (const id of ids) n.add(id); return n; })}
        />
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Links to leave</label>
          <span className="text-xs text-muted-foreground">{linkCount} link(s) · {accountIds.size} account(s)</span>
        </div>
        <Textarea
          rows={6}
          placeholder={"Paste one link per line. Supports:\nhttps://t.me/somechannel\n@somechannel\nhttps://t.me/+abcDEF123hash\nhttps://t.me/joinchat/abcDEF123hash\nhttps://t.me/c/1234567890"}
          value={linksText}
          onChange={(e) => setLinksText(e.target.value)}
          disabled={running}
        />
        <p className="text-xs text-muted-foreground">
          For each account, the app resolves each link and leaves the channel/group. Invite links (+HASH) are resolved without joining first.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={run} disabled={running || !accountIds.size || !linkCount} variant="destructive">
          <Play className="mr-1 h-4 w-4" /> {running ? "Running…" : "Leave on selected accounts"}
        </Button>
        <Button onClick={stop} disabled={!running} variant="outline">
          <Square className="mr-1 h-4 w-4" /> Stop
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h3 className="font-semibold">Live logs</h3>
          <Button size="sm" variant="ghost" onClick={() => setLogs([])} disabled={!logs.length}>Clear</Button>
        </div>
        <ScrollArea className="h-72">
          <div className="p-3 font-mono text-xs">
            {logs.length === 0 ? (
              <p className="text-muted-foreground">No events yet.</p>
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

function CleanupPanelInner({ mode, kind }: { mode: "chats" | "personal"; kind?: KindFilter }) {
  const listAcc = useServerFn(listAccounts);
  const queryClient = useQueryClient();
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });

  const [accountIds, setAccountIds] = useState<Set<string>>(new Set());
  const defaultAction: Action =
    mode === "personal"
      ? "deletePersonal"
      : kind === "bots" || kind === "users"
        ? "block"
        : "leave";
  const [action, setAction] = useState<Action>(defaultAction);
  const [query, setQuery] = useState("");
  const defaultDelays = useMemo<{ min: number; max: number }>(() => {
    if (kind === "bots") return { min: 8, max: 20 };
    if (kind === "users") return { min: 10, max: 25 };
    if (mode === "personal") return { min: 6, max: 15 };
    return { min: 2, max: 6 };
  }, [kind, mode]);
  const [minDelay, setMinDelay] = useState<number>(defaultDelays.min);
  const [maxDelay, setMaxDelay] = useState<number>(defaultDelays.max);
  useEffect(() => {
    setMinDelay(defaultDelays.min);
    setMaxDelay(defaultDelays.max);
  }, [defaultDelays]);
  const [selectedByAcc, setSelectedByAcc] = useState<Record<string, Set<string>>>({});
  // Keys currently visible (after search + kind filters) per account, reported by each column.
  const [filteredByAcc, setFilteredByAcc] = useState<Record<string, string[]>>({});
  const totalsFor = (ids: string[]) => {
    let shown = 0;
    let sel = 0;
    for (const id of ids) {
      const keys = filteredByAcc[id] ?? [];
      shown += keys.length;
      const s = selectedByAcc[id];
      if (s) for (const k of keys) if (s.has(k)) sel++;
    }
    return { shown, sel };
  };
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
        body: JSON.stringify({
          action,
          jobs,
          minDelayMs: Math.max(0, Math.floor(minDelay * 1000)),
          maxDelayMs: Math.max(0, Math.floor(maxDelay * 1000)),
        }),
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
  const { shown: totalShown, sel: totalSelected } = totalsFor(idsArr);

  return (
    <div className="space-y-4">
      {/* Accounts */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Accounts</h2>
          <div className="flex flex-wrap items-center gap-2">
            <AccountRangeControls
              total={accountsQ.data?.length ?? 0}
              onApply={(s, e, order) => {
                const picked = pickRange(accountsQ.data ?? [], s, e, order).map((a) => a.id);
                setAccountIds(new Set(picked));
              }}
            />
            <Button variant="outline" size="sm" onClick={toggleAllAccounts}>
              {accountIds.size === (accountsQ.data?.length ?? 0) && (accountsQ.data?.length ?? 0) > 0
                ? "Deselect all"
                : "Select all"}
            </Button>
          </div>
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
        <AccountIdPaste
          className="mt-3"
          accounts={accountsQ.data ?? []}
          onSelect={(ids) =>
            setAccountIds((prev) => {
              const next = new Set(prev);
              for (const id of ids) next.add(id);
              return next;
            })
          }
        />
      </div>

      {/* Controls */}
      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Action</label>
          {mode === "personal" ? (
            <Select value="deletePersonal" onValueChange={() => {}}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="deletePersonal">Delete personal chat (both sides)</SelectItem>
              </SelectContent>
            </Select>
          ) : kind === "bots" || kind === "users" ? (
            <Select value={action} onValueChange={(v) => { setAction(v as Action); setSelectedByAcc({}); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="block">Block {kind === "bots" ? "bot" : "user"} + delete both sides</SelectItem>
                <SelectItem value="deleteHistory">Delete history (my side)</SelectItem>
                <SelectItem value="mute">Mute selected</SelectItem>
                <SelectItem value="unmute">Unmute selected</SelectItem>
                <SelectItem value="archive">Archive selected</SelectItem>
                <SelectItem value="unarchive">Unarchive selected</SelectItem>
                <SelectItem value="pin">Pin selected</SelectItem>
                <SelectItem value="unpin">Unpin selected</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Select value={action} onValueChange={(v) => { setAction(v as Action); setSelectedByAcc({}); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="leave">Leave channels / groups</SelectItem>
                <SelectItem value="deleteHistory">Delete history (my side)</SelectItem>
                <SelectItem value="mute">Mute selected chats</SelectItem>
                <SelectItem value="unmute">Unmute selected chats</SelectItem>
                <SelectItem value="archive">Archive selected chats</SelectItem>
                <SelectItem value="unarchive">Unarchive selected chats</SelectItem>
                <SelectItem value="pin">Pin selected chats</SelectItem>
                <SelectItem value="unpin">Unpin selected chats</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="md:col-span-1">
          <label className="mb-1 block text-xs text-muted-foreground">Search</label>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title or @username" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Min delay (sec)</label>
          <Input
            type="number"
            min={0}
            max={120}
            value={minDelay}
            onChange={(e) => setMinDelay(Math.max(0, Number(e.target.value) || 0))}
            disabled={running}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Max delay (sec)</label>
          <Input
            type="number"
            min={0}
            max={120}
            value={maxDelay}
            onChange={(e) => setMaxDelay(Math.max(0, Number(e.target.value) || 0))}
            disabled={running}
          />
        </div>
        <p className="text-xs text-muted-foreground md:col-span-4">
          {kind === "bots"
            ? "Bots: recommended 8–20s to avoid contacts.Block FloodWait. Block auto-skips if rate-limited (chat still gets deleted)."
            : kind === "users"
              ? "Users: recommended 10–25s. Same FloodWait fallback as bots."
              : mode === "personal"
                ? "Personal chats: 6–15s is safe for two-sided delete."
                : "Channels/groups: 2–6s is usually fine for leaves."}
        </p>
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

      {/* Global chat selection across every open account column */}
      {idsArr.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
          <span className="text-xs text-muted-foreground">
            All accounts{query ? ` · matching “${query}”` : ""}:
            {" "}
            <span className="font-mono text-foreground">{totalShown}</span> shown ·{" "}
            <span className="font-mono text-foreground">{totalSelected}</span> selected
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={running || !totalShown}
            onClick={() =>
              setSelectedByAcc((prev) => {
                const next = { ...prev };
                for (const id of idsArr) {
                  const n = new Set(next[id] ?? []);
                  for (const k of filteredByAcc[id] ?? []) n.add(k);
                  next[id] = n;
                }
                return next;
              })
            }
          >
            Select all shown
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={running || !totalShown}
            onClick={() =>
              setSelectedByAcc((prev) => {
                const next = { ...prev };
                for (const id of idsArr) {
                  const n = new Set(next[id] ?? []);
                  for (const k of filteredByAcc[id] ?? []) n.delete(k);
                  next[id] = n;
                }
                return next;
              })
            }
          >
            Deselect all shown
          </Button>
          <Button size="sm" variant="ghost" disabled={running || !totalSelected} onClick={() => setSelectedByAcc({})}>
            Clear every selection
          </Button>
        </div>
      )}

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
              kind={kind}
              action={mode === "personal" ? "deletePersonal" : action}
              query={query}
              selected={selectedByAcc[id] ?? new Set()}
              setSelected={(next) => setSelectedByAcc((p) => ({ ...p, [id]: next }))}
              onFilteredChange={(keys) => setFilteredByAcc((p) => ({ ...p, [id]: keys }))}
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
  kind,
  action,
  query,
  selected,
  setSelected,
  onFilteredChange,
  done,
  running,
}: {
  accountId: string;
  account?: { first_name: string | null; username: string | null; phone: string } | undefined;
  mode: "chats" | "personal";
  kind?: KindFilter;
  action: Action;
  query: string;
  selected: Set<string>;
  setSelected: (n: Set<string>) => void;
  onFilteredChange?: (keys: string[]) => void;
  done?: { ok: number; fail: number };
  running: boolean;
}) {
  const listDlg = useServerFn(listDialogs);
  const dialogs = useQuery({
    queryKey: ["dialogs", accountId],
    queryFn: () => listDlg({ data: { accountId } }) as Promise<Dialog[]>,
  });
  const filtered = useMemo(() => {
    const rows = (dialogs?.data ?? []) as Dialog[];
    return rows.filter((r) => {
      if (mode === "personal") {
        // personal chats = users (non-bot) with 1:1 kind
        if (r.type !== "user") return false;
      } else if (kind === "bots") {
        if (r.type !== "bot") return false;
      } else if (kind === "users") {
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
  }, [dialogs?.data, action, query, mode, kind]);

  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.key));
  // Only touch what's currently shown, so a search never wipes earlier picks.
  const toggleAll = () => {
    const n = new Set(selected);
    if (allSelected) for (const r of filtered) n.delete(r.key);
    else for (const r of filtered) n.add(r.key);
    setSelected(n);
  };
  const filteredKeys = useMemo(() => filtered.map((r) => r.key), [filtered]);
  useEffect(() => {
    onFilteredChange?.(filteredKeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredKeys]);
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
          <div className="p-3"><Loader size="sm" /></div>
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