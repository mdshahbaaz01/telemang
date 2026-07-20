import { useMemo, useRef, useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Play, Square, ChevronDown, ChevronUp, History, Trash2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { friendlyJoinReason } from "@/lib/telegram/errors";

type Account = { id: string; first_name?: string | null; username?: string | null; phone?: string | null };

type PreJoinLog = { level: "info" | "success" | "warn" | "error"; message: string; ts: number; target?: string; accountId?: string; reason?: string };

type ChStatus = "queued" | "attempting" | "requested" | "succeeded" | "skipped" | "failed";
type ChCell = { status: ChStatus; ts: number; message?: string; reason?: string; attempts?: number };
type ChMap = Record<string, Record<string, ChCell>>; // channel -> accountId -> cell

function normalizeTarget(t: string): string {
  return t.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "").toLowerCase();
}

function classify(level: string, message: string): ChStatus | null {
  const m = (message || "").toLowerCase();
  // Terminal skipped states (cache hit, in-flight elsewhere, already a member).
  if (/^skip\b|already cached|in-flight elsewhere|already[_ ]participant|user_already/.test(m)) return "skipped";
  // Explicit failures.
  if (level === "error" || /\bfail\b|\berror\b|flood_wait|floodwait|invalid|forbidden|banned|channel_private|channels_too_much|peer_id_invalid|username_not_occupied|invite_hash_expired|invite_hash_invalid/.test(m)) return "failed";
  // Approval-required channels — request queued on Telegram side.
  if (/invite_request_sent|request(ed)? to join|approval|pending approval/.test(m)) return "requested";
  // Terminal success.
  if (level === "success" || /membership verified|\bjoined\b|join ok|successfully joined|already a member/.test(m)) return "succeeded";
  // Attempt in flight — peek/import/direct calls.
  if (/attempt|trying|peek|import|resolving|connecting|joining|check invite|checkchatinvite/.test(m)) return "attempting";
  return null;
}

const STATUS_STYLES: Record<ChStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  attempting: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  requested: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  succeeded: "bg-green-500/15 text-green-600 dark:text-green-400",
  skipped: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  failed: "bg-destructive/15 text-destructive",
};

// Rank so a later log that classifies to a weaker state (e.g. "attempting")
// cannot regress a terminal state (succeeded/failed/skipped/requested).
const STATUS_RANK: Record<ChStatus, number> = {
  queued: 0, attempting: 1, requested: 3, skipped: 3, failed: 3, succeeded: 4,
};

type PreJoinHistoryEntry = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  channels: string[];
  accountIds: string[];
  ok: number;
  fail: number;
  status: "running" | "done" | "stopped" | "error";
  logs: PreJoinLog[];
};

const HISTORY_KEY = "botflow.prejoin.history.v1";
const MAX_HISTORY = 25;

function loadHistory(): PreJoinHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(list: PreJoinHistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch {}
}

export function PreJoinCard({ accounts }: { accounts: Account[] }) {
  const [hidden, setHidden] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [text, setText] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [publicInviteFallback, setPublicInviteFallback] = useState(true);
  const [forceRejoin, setForceRejoin] = useState(false);
  const [logs, setLogs] = useState<PreJoinLog[]>([]);
  const [totals, setTotals] = useState<{ ok: number; fail: number } | null>(null);
  const [statuses, setStatuses] = useState<ChMap>({});
  const [statusOpen, setStatusOpen] = useState(true);
  const [history, setHistory] = useState<PreJoinHistoryEntry[]>(() => loadHistory());
  const abortRef = useRef<AbortController | null>(null);
  const currentEntryRef = useRef<PreJoinHistoryEntry | null>(null);

  const allIds = useMemo(() => accounts.map((a) => a.id), [accounts]);
  const channels = useMemo(
    () => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 100),
    [text],
  );
  const nameOf = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a?.first_name || a?.username || a?.phone || id.slice(0, 8);
  };

  useEffect(() => { saveHistory(history); }, [history]);

  const addLog = (l: Omit<PreJoinLog, "ts">) => {
    const entry: PreJoinLog = { ...l, ts: Date.now() };
    setLogs((prev) => [entry, ...prev].slice(0, 500));
    if (currentEntryRef.current) currentEntryRef.current.logs.unshift(entry);
  };

  const updateStatus = (channel: string, accountId: string, status: ChStatus, message?: string, reason?: string, bumpAttempt?: boolean) => {
    const key = normalizeTarget(channel);
    if (!key) return;
    setStatuses((prev) => {
      const row = { ...(prev[key] || {}) };
      const cur = row[accountId];
      if (cur && STATUS_RANK[cur.status] > STATUS_RANK[status]) return prev;
      row[accountId] = {
        status,
        ts: Date.now(),
        message,
        reason: reason ?? cur?.reason,
        attempts: (cur?.attempts ?? 0) + (bumpAttempt ? 1 : 0),
      };
      return { ...prev, [key]: row };
    });
  };

  const commitCurrent = (patch: Partial<PreJoinHistoryEntry>) => {
    const cur = currentEntryRef.current;
    if (!cur) return;
    Object.assign(cur, patch);
    setHistory((prev) => {
      const others = prev.filter((h) => h.id !== cur.id);
      return [{ ...cur, logs: cur.logs.slice(0, 200) }, ...others].slice(0, MAX_HISTORY);
    });
  };

  const run = async () => {
    if (!channels.length) return toast.error("Add at least one channel");
    const ids = selectedIds.length ? selectedIds : allIds;
    if (!ids.length) return toast.error("Select at least one account");

    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return toast.error("Not signed in");

    setLogs([]);
    setTotals(null);
    // seed pending matrix
    {
      const seed: ChMap = {};
      const ts = Date.now();
      for (const ch of channels) {
        const key = normalizeTarget(ch);
        seed[key] = {};
        for (const id of ids) seed[key][id] = { status: "queued", ts };
      }
      setStatuses(seed);
    }
    setRunning(true);
    const entry: PreJoinHistoryEntry = {
      id: `${Date.now()}`,
      startedAt: Date.now(),
      channels,
      accountIds: ids,
      ok: 0,
      fail: 0,
      status: "running",
      logs: [],
    };
    currentEntryRef.current = entry;
    setHistory((prev) => [entry, ...prev].slice(0, MAX_HISTORY));

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/public/actions-stream", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          accountIds: ids,
          minDelay: 1,
          maxDelay: 2,
          op: {
            kind: "botflow",
            bot: "",
            steps: [],
            preJoinOnly: true,
            autoJoinRequired: false,
            preJoinChannels: channels,
            publicInviteFallback,
            forceRejoin,
          },
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        throw new Error(`Stream failed: ${res.status}${t ? ` — ${t}` : ""}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let ok = 0;
      let fail = 0;
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
          if (event === "start") addLog({ level: "info", message: "Pre-join started" });
          else if (event === "log") {
            addLog({ accountId: data.accountId, level: data.level ?? "info", target: data.target, message: data.message ?? "", reason: data.reason });
            if (data.target && data.accountId) {
              // Prefer the server's terminal marker; fall back to text classification.
              const s: ChStatus | null = data.terminal
                ? (data.terminal === "joined" ? "succeeded" : data.terminal as ChStatus)
                : classify(data.level ?? "info", data.message ?? "");
              const isAttempt = /Attempting join|Retry \d+\//i.test(data.message ?? "");
              if (s) {
                const reason = data.reason ?? friendlyJoinReason({ code: data.errorCode, message: data.message, status: data.terminal, floodSeconds: data.floodSeconds }) ?? undefined;
                updateStatus(data.target, data.accountId, s, data.message, reason, isAttempt);
              } else if (isAttempt) {
                updateStatus(data.target, data.accountId, "attempting", data.message, undefined, true);
              }
            }
          }
          else if (event === "done") {
            ok += Number(data.ok ?? 0);
            fail += Number(data.fail ?? 0);
            addLog({ accountId: data.accountId, level: data.fail ? "warn" : "info", message: `Account done — ok ${data.ok}, fail ${data.fail}` });
          } else if (event === "end") {
            setTotals({ ok: data.ok ?? ok, fail: data.fail ?? fail });
            const message = `Finished — ok ${data.ok ?? ok}, fail ${data.fail ?? fail}`;
            if ((data.fail ?? fail)) toast.warning(message); else toast.success(message);
          } else if (event === "aborted") addLog({ level: "warn", message: data.message ?? "Stopped" });
        }
      }
      commitCurrent({ finishedAt: Date.now(), ok, fail, status: ac.signal.aborted ? "stopped" : "done" });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const message = (e as Error).message;
        addLog({ level: "error", message });
        toast.error(message);
        commitCurrent({ finishedAt: Date.now(), status: "error" });
      } else {
        commitCurrent({ finishedAt: Date.now(), status: "stopped" });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      currentEntryRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const toggleId = (id: string) =>
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const clearHistory = () => {
    setHistory([]);
    saveHistory([]);
  };
  const removeHistory = (id: string) => setHistory((prev) => prev.filter((h) => h.id !== id));
  const reuseHistory = (h: PreJoinHistoryEntry) => {
    setText(h.channels.join("\n"));
    setSelectedIds(h.accountIds.filter((id) => allIds.includes(id)));
    setHistoryOpen(false);
    toast.success("Loaded from history");
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium mr-auto">Pre-join channels</h2>
        <Button size="sm" variant="outline" onClick={() => setHistoryOpen((v) => !v)}>
          <History className="mr-1 h-4 w-4" />
          {historyOpen ? "Hide history" : `History${history.length ? ` (${history.length})` : ""}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setHidden((v) => !v)}>
          {hidden ? <ChevronDown className="mr-1 h-4 w-4" /> : <ChevronUp className="mr-1 h-4 w-4" />}
          {hidden ? "Show" : "Hide"}
        </Button>
      </div>

      {!hidden && (
        <>
          <div>
            <Label>Channels (one per line — @channel, https://t.me/xxx, +invitehash)</Label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"@channel1\nhttps://t.me/foo\nt.me/+abcdef"}
              rows={3}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {channels.length} channel(s) parsed. Joined from every selected account, independent of any bot flow.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium mr-auto">
                {selectedIds.length} / {allIds.length} accounts selected
              </div>
              <Button size="sm" variant="outline" onClick={() => setSelectorOpen((v) => !v)}>
                {selectorOpen ? "Close select" : "Select"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSelectedIds(allIds)}>All</Button>
              <Button size="sm" variant="outline" onClick={() => setSelectedIds([])}>None</Button>
            </div>
            {selectorOpen && (
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-56 overflow-auto rounded-md border border-border p-2">
                {accounts.map((a) => {
                  const checked = selectedIds.includes(a.id);
                  return (
                    <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40">
                      <input type="checkbox" checked={checked} onChange={() => toggleId(a.id)} />
                      <span className="truncate">{nameOf(a.id)}</span>
                    </label>
                  );
                })}
                {accounts.length === 0 && <p className="text-xs text-muted-foreground">No accounts yet.</p>}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={running || channels.length === 0}>
              <Play className="mr-1 h-4 w-4" /> Run pre-join
            </Button>
            <Button variant="destructive" onClick={stop} disabled={!running}>
              <Square className="mr-1 h-4 w-4" /> Stop
            </Button>
            <label className="flex items-center gap-2 self-center text-xs text-muted-foreground" title="If a t.me/+hash invite fails but the channel is actually public, peek it and join via @username.">
              <input
                type="checkbox"
                checked={publicInviteFallback}
                onChange={(e) => setPublicInviteFallback(e.target.checked)}
              />
              Public invite fallback
            </label>
            <label
              className="flex items-center gap-2 self-center text-xs text-muted-foreground"
              title="Ignore the per-account join cache and re-attempt these channels even if they were joined/attempted before."
            >
              <input
                type="checkbox"
                checked={forceRejoin}
                onChange={(e) => setForceRejoin(e.target.checked)}
              />
              Force re-join (ignore cache)
            </label>
            {totals && (
              <div className="ml-auto self-center text-sm text-muted-foreground">
                ok {totals.ok} · fail {totals.fail}
              </div>
            )}
          </div>

          {Object.keys(statuses).length > 0 && (
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold mr-auto">Per-account status</h2>
                <Button size="sm" variant="ghost" onClick={() => setStatusOpen((v) => !v)}>
                  {statusOpen ? "Hide" : "Show"}
                </Button>
              </div>
              {statusOpen && (
                <div className="max-h-80 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(() => {
                    // Invert: group by account id, each account gets a box with its channel chips.
                    const perAcct = new Map<string, Array<{ channel: string; status: ChStatus; ts: number; message?: string }>>();
                    for (const [ch, row] of Object.entries(statuses)) {
                      for (const [aid, cell] of Object.entries(row)) {
                        if (!perAcct.has(aid)) perAcct.set(aid, []);
                        perAcct.get(aid)!.push({ channel: ch, ...cell });
                      }
                    }
                    return Array.from(perAcct.entries()).map(([aid, list]) => {
                      const counts: Record<ChStatus, number> = { queued: 0, attempting: 0, requested: 0, succeeded: 0, skipped: 0, failed: 0 };
                      let latest = 0;
                      for (const c of list) { counts[c.status]++; if (c.ts > latest) latest = c.ts; }
                      return (
                        <div key={aid} className="rounded-lg border border-border bg-card p-3 text-xs">
                          <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-border/50 pb-2">
                            <span className="text-sm font-semibold">{nameOf(aid)}</span>
                            <span className="text-muted-foreground">· {list.length} ch</span>
                            {(["succeeded","requested","attempting","skipped","failed","queued"] as ChStatus[]).map((s) => counts[s] ? (
                              <span key={s} className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLES[s]}`}>{s} {counts[s]}</span>
                            ) : null)}
                            <span className="ml-auto text-muted-foreground">{latest ? new Date(latest).toLocaleTimeString() : ""}</span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {list.map((c) => (
                              <span
                                key={c.channel}
                                className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${STATUS_STYLES[c.status]}`}
                                title={`${c.channel} · ${c.status} · ${new Date(c.ts).toLocaleTimeString()}${c.message ? ` — ${c.message}` : ""}`}
                              >
                                {c.channel}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </section>
          )}

          {logs.length > 0 && (
            <div className="max-h-52 overflow-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-[11px]">
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === "error" ? "text-destructive"
                      : l.level === "warn" ? "text-yellow-600 dark:text-yellow-400"
                      : l.level === "success" ? "text-green-600 dark:text-green-400"
                      : "text-foreground"
                  }
                >
                  [{new Date(l.ts).toLocaleTimeString()}]
                  {l.accountId ? ` ${nameOf(l.accountId)}` : ""}
                  {l.target ? ` · ${l.target}` : ""} — {l.message}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {historyOpen && (
        <div className="rounded-md border border-border bg-muted/20 p-2 space-y-2">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium mr-auto">Recent pre-join runs</div>
            <Button size="sm" variant="ghost" onClick={clearHistory} disabled={!history.length}>
              <Trash2 className="mr-1 h-4 w-4" /> Clear all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(false)}>Hide history</Button>
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="space-y-1 max-h-64 overflow-auto">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 rounded border border-border/50 bg-background/60 px-2 py-1 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-medium">{new Date(h.startedAt).toLocaleString()}</span>
                      <span className="text-muted-foreground"> · {h.channels.length} ch · {h.accountIds.length} acct · {h.status}</span>
                      <span className="text-muted-foreground"> · ok {h.ok} / fail {h.fail}</span>
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground" title={h.channels.join(", ")}>
                      {h.channels.slice(0, 5).join(", ")}{h.channels.length > 5 ? ` +${h.channels.length - 5}` : ""}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => reuseHistory(h)}>Reuse</Button>
                  <button
                    type="button"
                    onClick={() => removeHistory(h.id)}
                    className="rounded p-1 text-muted-foreground hover:text-destructive"
                    aria-label="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}