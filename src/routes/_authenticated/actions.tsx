import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { listAccounts } from "@/lib/accounts.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { AdminGate } from "@/components/AdminGate";
import { Square, Play } from "lucide-react";

export const Route = createFileRoute("/_authenticated/actions")({
  component: () => (
    <AdminGate>
      <ActionsPage />
    </AdminGate>
  ),
});

type Tab = "react" | "forward" | "vote";

type LogEntry = {
  accountId?: string;
  level: "info" | "success" | "warn" | "error";
  target?: string;
  message: string;
  ts: number;
};

function parseMessageLink(input: string): { chat: string; msgId: number } | null {
  const s = input.trim();
  const m = s.match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(c\/\d+|[a-zA-Z0-9_]+)\/(\d+)/,
  );
  if (!m) return null;
  return { chat: m[1], msgId: Number(m[2]) };
}

function ActionsPage() {
  return <ActionsPageInner />;
}

function DelayFields({
  minDelay,
  maxDelay,
  setMin,
  setMax,
}: {
  minDelay: number;
  maxDelay: number;
  setMin: (n: number) => void;
  setMax: (n: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label>Min delay (s)</Label>
        <Input
          type="number"
          value={minDelay}
          onChange={(e) => setMin(Number(e.target.value))}
        />
      </div>
      <div>
        <Label>Max delay (s)</Label>
        <Input
          type="number"
          value={maxDelay}
          onChange={(e) => setMax(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

function ActionsPageInner() {
  const listAcc = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });

  const [tab, setTab] = useState<Tab>("react");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [source, setSource] = useState("");
  const [emoji, setEmoji] = useState("👍");
  const [targets, setTargets] = useState("");
  const [options, setOptions] = useState("0");
  const [minDelay, setMinDelay] = useState(2);
  const [maxDelay, setMaxDelay] = useState(6);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<{ ok: number; fail: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const accountList = accountsQ.data ?? [];
  const allSelected = useMemo(
    () => accountList.length > 0 && accountList.every((a) => selected.has(a.id)),
    [accountList, selected],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(accountList.map((a) => a.id)));
  };

  const addLog = (l: Omit<LogEntry, "ts">) =>
    setLogs((prev) => [{ ...l, ts: Date.now() }, ...prev].slice(0, 500));

  const run = async () => {
    const src = parseMessageLink(source);
    if (!src) {
      toast.error("Enter a valid message link (https://t.me/<chat>/<id>)");
      return;
    }
    if (selected.size === 0) {
      toast.error("Pick at least one account");
      return;
    }

    let op: unknown;
    if (tab === "react") {
      if (!emoji.trim()) return toast.error("Pick an emoji");
      op = { kind: "react", source: src, emoji: emoji.trim() };
    } else if (tab === "forward") {
      const list = targets
        .split(/\r?\n|,/) 
        .map((s) => s.trim())
        .filter(Boolean);
      if (!list.length) return toast.error("Enter at least one destination");
      op = { kind: "forward", source: src, targets: list };
    } else {
      const opts = options
        .split(/[,\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0);
      if (!opts.length) return toast.error("Enter option indexes (e.g. 0,2)");
      op = { kind: "vote", source: src, options: opts };
    }

    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return toast.error("Not signed in");

    setLogs([]);
    setTotals(null);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/public/actions-stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          accountIds: [...selected],
          minDelay,
          maxDelay,
          op,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        toast.error(`Stream failed: ${res.status} ${t}`);
        setRunning(false);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const evLine = chunk.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!evLine || !dataLine) continue;
          const event = evLine.slice(7).trim();
          let data: any = {};
          try {
            data = JSON.parse(dataLine.slice(6));
          } catch {}
          if (event === "log") {
            addLog({
              accountId: data.accountId,
              level: data.level ?? "info",
              target: data.target,
              message: data.message ?? "",
            });
          } else if (event === "done") {
            addLog({
              accountId: data.accountId,
              level: "info",
              message: `Account done — ok ${data.ok}, fail ${data.fail}`,
            });
          } else if (event === "end") {
            setTotals({ ok: data.ok ?? 0, fail: data.fail ?? 0 });
            toast.success(`Finished — ok ${data.ok}, fail ${data.fail}`);
          } else if (event === "aborted") {
            addLog({ level: "warn", message: data.message ?? "Stopped" });
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        toast.error((e as Error).message);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 md:px-8">
          <h1 className="mr-auto text-xl font-semibold">Actions</h1>
          <a href="/dashboard" className="text-sm text-muted-foreground underline">
            Back to dashboard
          </a>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 md:grid-cols-[280px_1fr] md:px-8">
        {/* Accounts column */}
        <aside className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Accounts ({selected.size}/{accountList.length})</div>
            <button className="text-xs underline" onClick={toggleAll}>
              {allSelected ? "Clear" : "Select all"}
            </button>
          </div>
          <div className="max-h-[70vh] space-y-1 overflow-auto">
            {accountList.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <span className="truncate">
                  {a.first_name || a.username || a.phone}
                </span>
              </label>
            ))}
            {accountList.length === 0 && (
              <p className="text-xs text-muted-foreground">No accounts yet.</p>
            )}
          </div>
        </aside>

        {/* Main panel */}
        <section className="space-y-4">
          <div className="flex gap-2 border-b border-border">
            {(["react", "forward", "vote"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm capitalize ${
                  tab === t
                    ? "border-b-2 border-primary font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {t === "react" ? "Reactions" : t === "forward" ? "Forwarder" : "Poll voter"}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div>
              <Label>Source message link</Label>
              <Input
                placeholder="https://t.me/channel/12345"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Supports public (@name) and private (c/&lt;id&gt;) chats.
              </p>
            </div>

            {tab === "react" && (
              <>
                <div>
                  <Label>Emoji</Label>
                  <Input
                    value={emoji}
                    onChange={(e) => setEmoji(e.target.value)}
                    maxLength={20}
                    className="w-24"
                  />
                </div>
                <DelayFields
                  minDelay={minDelay}
                  maxDelay={maxDelay}
                  setMin={setMinDelay}
                  setMax={setMaxDelay}
                />
              </>
            )}

            {tab === "forward" && (
              <>
                <div>
                  <Label>Destinations (one per line or comma-separated)</Label>
                  <Textarea
                    rows={5}
                    value={targets}
                    onChange={(e) => setTargets(e.target.value)}
                    placeholder="@mychannel&#10;@friend_username&#10;https://t.me/other"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Min delay (s)</Label>
                    <Input
                      type="number"
                      value={minDelay}
                      onChange={(e) => setMinDelay(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <Label>Max delay (s)</Label>
                    <Input
                      type="number"
                      value={maxDelay}
                      onChange={(e) => setMaxDelay(Number(e.target.value))}
                    />
                  </div>
                </div>
              </>
            )}

            {tab === "vote" && (
              <>
                <div>
                  <Label>Option indexes (0-based, comma-separated)</Label>
                  <Input
                    value={options}
                    onChange={(e) => setOptions(e.target.value)}
                    placeholder="0 or 0,2 for multi-select polls"
                  />
                </div>
                <DelayFields
                  minDelay={minDelay}
                  maxDelay={maxDelay}
                  setMin={setMinDelay}
                  setMax={setMaxDelay}
                />
              </>
            )}

            <div className="flex gap-2 pt-2">
              <Button onClick={run} disabled={running || selected.size === 0}>
                <Play className="mr-1 h-4 w-4" />
                Run on {selected.size} account{selected.size === 1 ? "" : "s"}
              </Button>
              <Button variant="destructive" onClick={stop} disabled={!running}>
                <Square className="mr-1 h-4 w-4" /> Stop
              </Button>
              {totals && (
                <div className="ml-auto self-center text-sm text-muted-foreground">
                  ok {totals.ok} · fail {totals.fail}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 text-sm font-medium">Live logs</div>
            <div className="max-h-[50vh] space-y-1 overflow-auto font-mono text-xs">
              {logs.length === 0 && (
                <p className="text-muted-foreground">No activity yet.</p>
              )}
              {logs.map((l, i) => {
                const acc = accountList.find((a) => a.id === l.accountId);
                const who = acc ? acc.first_name || acc.username || acc.phone : l.accountId ? l.accountId.slice(0, 8) : "—";
                const color =
                  l.level === "error"
                    ? "text-destructive"
                    : l.level === "success"
                      ? "text-green-600 dark:text-green-400"
                      : l.level === "warn"
                        ? "text-yellow-600 dark:text-yellow-400"
                        : "text-foreground";
                return (
                  <div key={i} className={color}>
                    <span className="text-muted-foreground">
                      {new Date(l.ts).toLocaleTimeString()} [{who}]
                    </span>{" "}
                    {l.target ? <span className="text-muted-foreground">{l.target} —</span> : null} {l.message}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}