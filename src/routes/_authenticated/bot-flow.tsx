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

  const [referLink, setReferLink] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<{ ok: number; fail: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const accountList = accountsQ.data ?? [];
  const allIds = useMemo(() => accountList.map((a) => a.id), [accountList]);

  // Parse a bot referral link/handle preview for the user.
  const parsed = useMemo(() => {
    const raw = referLink.trim();
    if (!raw) return null;
    try {
      let username = "";
      let startParam = "";
      if (raw.startsWith("@")) {
        username = raw.slice(1);
      } else if (raw.includes("t.me/") || raw.startsWith("http")) {
        const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
        username = url.pathname.replace(/^\/+/, "").split("/")[0];
        startParam = url.searchParams.get("start") || url.searchParams.get("startapp") || "";
      } else {
        username = raw;
      }
      return { username, startParam };
    } catch {
      return { username: raw, startParam: "" };
    }
  }, [referLink]);

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
    const link = referLink.trim();
    if (!link) return toast.error("Paste a bot referral link");
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
          minDelay: 2,
          maxDelay: 5,
          op: {
            kind: "botflow",
            bot: link,
            // A no-op step keeps the server schema happy; /start (with the ref
            // param parsed from the link) is fired before steps run, so the
            // referrer is already credited by then.
            steps: ["wait:2"],
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
          <h2 className="text-lg font-medium">Run a bot with your referral link</h2>

          <div>
            <Label>Bot referral link</Label>
            <Input
              value={referLink}
              onChange={(e) => setReferLink(e.target.value)}
              placeholder="https://t.me/somebot?start=YOUR_REF_CODE"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Paste your full referral URL. Every selected account will
              <code className="mx-1">/start</code>
              the bot using this link, so the refer count goes to your ref code.
            </p>
            {parsed?.username && (
              <div className="mt-2 text-xs text-muted-foreground">
                Bot: <span className="font-mono text-foreground">@{parsed.username}</span>
                {parsed.startParam ? (
                  <>
                    {" "}· Ref code:{" "}
                    <span className="font-mono text-foreground">{parsed.startParam}</span>
                  </>
                ) : (
                  <span className="text-yellow-600 dark:text-yellow-400">
                    {" "}· No <code>start</code> code found in the link
                  </span>
                )}
              </div>
            )}
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