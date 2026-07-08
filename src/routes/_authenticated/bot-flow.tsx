import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { listAccounts } from "@/lib/accounts.functions";
import { AdminGate } from "@/components/AdminGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Play, Square, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/bot-flow")({
  component: () => (
    <AdminGate>
      <BotFlowPage />
    </AdminGate>
  ),
});

type LogEntry = {
  accountId?: string;
  level: "info" | "success" | "warn" | "error";
  target?: string;
  message: string;
  ts: number;
};

function BotFlowPage() {
  const listAcc = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });

  const [bot, setBot] = useState("");
  const [startParam, setStartParam] = useState("");
  const [steps, setSteps] = useState("text:/start\nwait:3");
  const [minDelay, setMinDelay] = useState(2);
  const [maxDelay, setMaxDelay] = useState(5);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<{ ok: number; fail: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const accountList = accountsQ.data ?? [];
  const allIds = useMemo(() => accountList.map((a) => a.id), [accountList]);

  const addLog = (l: Omit<LogEntry, "ts">) =>
    setLogs((prev) => [{ ...l, ts: Date.now() }, ...prev].slice(0, 500));

  const toggle = (id: string) =>
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const readStream = async (res: Response) => {
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      const message = `Stream failed: ${res.status}${t ? ` — ${t}` : ""}`;
      addLog({ level: "error", message });
      toast.error(message);
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
        try { data = JSON.parse(dataLine.slice(6)); } catch {}
        if (event === "start") addLog({ level: "info", message: "Run started" });
        else if (event === "log") addLog({ accountId: data.accountId, level: data.level ?? "info", target: data.target, message: data.message ?? "" });
        else if (event === "done") addLog({ accountId: data.accountId, level: data.fail ? "warn" : "info", message: `Account done — ok ${data.ok}, fail ${data.fail}` });
        else if (event === "end") {
          setTotals({ ok: data.ok ?? 0, fail: data.fail ?? 0 });
          const message = `Finished — ok ${data.ok}, fail ${data.fail}`;
          if (data.fail) toast.warning(message); else toast.success(message);
        } else if (event === "aborted") addLog({ level: "warn", message: data.message ?? "Stopped" });
      }
    }
  };

  const run = async () => {
    if (!bot.trim()) return toast.error("Enter a bot username or link");
    const stepList = steps.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!stepList.length) return toast.error("Add at least one step");
    const accountIds = selectedIds.length ? selectedIds : allIds;
    if (!accountIds.length) return toast.error("Select at least one account");

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
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          accountIds,
          minDelay,
          maxDelay,
          op: {
            kind: "botflow",
            bot: bot.trim(),
            ...(startParam.trim() ? { startParam: startParam.trim() } : {}),
            steps: stepList,
          },
        }),
        signal: ac.signal,
      });
      await readStream(res);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const message = (e as Error).message;
        addLog({ level: "error", message });
        toast.error(message);
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
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
        <Link to="/dashboard" className="inline-flex items-center gap-1 text-sm text-primary underline">
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Bot Flow</h1>

        <section className="rounded-lg border border-border bg-card p-4 space-y-4">
          <h2 className="text-lg font-medium">Run scripted steps</h2>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>Bot username or link</Label>
              <Input
                value={bot}
                onChange={(e) => setBot(e.target.value)}
                placeholder="@botname, t.me/botname, or https://t.me/botname?start=REFCODE"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Paste a full referral link and the <code>start</code>/<code>startapp</code> code is used automatically.
              </p>
            </div>
            <div>
              <Label>Start parameter (optional override)</Label>
              <Input
                value={startParam}
                onChange={(e) => setStartParam(e.target.value)}
                placeholder="Leave blank to use the one from the link"
              />
            </div>
          </div>

          <div>
            <Label>Steps</Label>
            <Textarea
              rows={8}
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              placeholder="text:/start&#10;wait:3&#10;click:Join&#10;text:Done"
              className="font-mono text-sm"
            />
            <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
              <div><code>text:&lt;message&gt;</code> — send text</div>
              <div><code>click:&lt;button label&gt;</code> — tap an inline/reply button matching the label</div>
              <div><code>wait:&lt;seconds&gt;</code> — pause (max 120s)</div>
              <div><code>start:&lt;param&gt;</code> — call /start again with a param</div>
              <div>Lines starting with <code>#</code> are ignored.</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Min delay between steps (s)</Label>
              <Input type="number" value={minDelay} onChange={(e) => setMinDelay(Number(e.target.value))} />
            </div>
            <div>
              <Label>Max delay between steps (s)</Label>
              <Input type="number" value={maxDelay} onChange={(e) => setMaxDelay(Number(e.target.value))} />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium mr-auto">
                {selectedIds.length} / {allIds.length} accounts selected
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setSelectedIds(allIds)}>Select all</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setSelectedIds([])}>Deselect all</Button>
            </div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-72 overflow-auto rounded-md border border-border p-2">
              {accountList.map((a) => {
                const checked = selectedIds.includes(a.id);
                return (
                  <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40">
                    <input type="checkbox" checked={checked} onChange={() => toggle(a.id)} />
                    <span className="truncate">{a.first_name || a.username || a.phone}</span>
                  </label>
                );
              })}
              {accountList.length === 0 && (
                <p className="text-xs text-muted-foreground">No accounts yet.</p>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={run} disabled={running || allIds.length === 0}>
              <Play className="mr-1 h-4 w-4" /> Run flow
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
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 text-sm font-medium">Live logs</div>
          <div className="max-h-[50vh] space-y-1 overflow-auto font-mono text-xs">
            {logs.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
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
        </section>
      </div>
    </main>
  );
}