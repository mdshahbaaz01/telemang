import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { listDialogs } from "@/lib/tg-viewer.functions";
import { previewMessageRange } from "@/lib/forward-range.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Forward, ArrowRight, Play, RotateCcw, Square, X } from "lucide-react";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/forward-range")({
  beforeLoad: requireAdminBeforeLoad,
  head: () => ({
    meta: [
      { title: "Forward Range — TeleManager Pro" },
      { name: "description", content: "Forward a range of messages from one Telegram chat to another." },
    ],
  }),
  component: ForwardRangePage,
});

type Dialog = {
  peerKey: string;
  title: string;
  username: string | null;
  kind: "user" | "group" | "channel";
  isBot: boolean;
  photoDataUrl: string | null;
};

function ChatPicker({
  label,
  dialogs,
  value,
  onChange,
  disabled,
}: {
  label: string;
  dialogs: Dialog[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return dialogs.slice(0, 300);
    return dialogs
      .filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          (d.username ?? "").toLowerCase().includes(q) ||
          d.peerKey.includes(q),
      )
      .slice(0, 300);
  }, [dialogs, filter]);
  const selected = dialogs.find((d) => d.peerKey === value);
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        placeholder="Search chats, @username, or paste peer key…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        disabled={disabled}
      />
      {selected && (
        <div className="rounded-md border p-2 text-sm bg-muted/40 flex items-center gap-2">
          <span className="font-medium truncate">{selected.title}</span>
          <span className="text-xs text-muted-foreground">
            {selected.kind}{selected.username ? ` · @${selected.username}` : ""}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onChange("")}>Clear</Button>
        </div>
      )}
      <div className="max-h-64 overflow-auto rounded-md border divide-y">
        {filtered.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">No chats match.</div>
        )}
        {filtered.map((d) => (
          <button
            key={d.peerKey}
            type="button"
            disabled={disabled}
            onClick={() => onChange(d.peerKey)}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 ${
              value === d.peerKey ? "bg-muted" : ""
            }`}
          >
            {d.photoDataUrl ? (
              <img src={d.photoDataUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
            ) : (
              <div className="h-6 w-6 rounded-full bg-muted-foreground/20" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{d.title}</div>
              <div className="text-[10px] text-muted-foreground truncate">
                {d.kind}{d.username ? ` · @${d.username}` : ""} · {d.peerKey}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MultiChatPicker({
  dialogs,
  values,
  onChange,
  disabled,
  excludeKey,
}: {
  dialogs: Dialog[];
  values: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  excludeKey?: string;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = dialogs.filter((d) => d.peerKey !== excludeKey);
    if (!q) return base.slice(0, 300);
    return base
      .filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          (d.username ?? "").toLowerCase().includes(q) ||
          d.peerKey.includes(q),
      )
      .slice(0, 300);
  }, [dialogs, filter, excludeKey]);
  const selected = new Set(values);
  const toggle = (k: string) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange([...next]);
  };
  const selectedList = dialogs.filter((d) => selected.has(d.peerKey));
  return (
    <div className="space-y-2">
      <Label>Targets ({values.length})</Label>
      <Input
        placeholder="Search chats, @username, or paste peer key…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        disabled={disabled}
      />
      {selectedList.length > 0 && (
        <div className="flex flex-wrap gap-1 rounded-md border p-2 bg-muted/40 max-h-28 overflow-auto">
          {selectedList.map((d) => (
            <span
              key={d.peerKey}
              className="inline-flex items-center gap-1 rounded-full bg-background border px-2 py-0.5 text-xs"
            >
              {d.title}
              <button type="button" onClick={() => toggle(d.peerKey)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => onChange([])}>
            Clear all
          </Button>
        </div>
      )}
      <div className="max-h-64 overflow-auto rounded-md border divide-y">
        {filtered.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">No chats match.</div>
        )}
        {filtered.map((d) => (
          <label
            key={d.peerKey}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 cursor-pointer ${
              selected.has(d.peerKey) ? "bg-muted" : ""
            }`}
          >
            <Checkbox
              checked={selected.has(d.peerKey)}
              onCheckedChange={() => toggle(d.peerKey)}
              disabled={disabled}
            />
            {d.photoDataUrl ? (
              <img src={d.photoDataUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
            ) : (
              <div className="h-6 w-6 rounded-full bg-muted-foreground/20" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{d.title}</div>
              <div className="text-[10px] text-muted-foreground truncate">
                {d.kind}{d.username ? ` · @${d.username}` : ""} · {d.peerKey}
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

type LogEntry = { level: string; message: string; targetKey?: string };
type TargetState = {
  key: string;
  title: string;
  ok: number;
  fail: number;
  total: number;
  lastMsgId: number;
  status: "queued" | "running" | "done" | "aborted";
};
type PreviewData = {
  total: number;
  existing: number;
  missing: number;
  firstId: number | null;
  lastId: number | null;
  sample: Array<{ id: number; kind: string; excerpt: string }>;
};

function ForwardRangePage() {
  const listAccountsFn = useServerFn(listAccounts);
  const listDialogsFn = useServerFn(listDialogs);
  const previewFn = useServerFn(previewMessageRange);

  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAccountsFn() });
  const accounts = accountsQ.data ?? [];

  const [accountId, setAccountId] = useState<string>("");
  const [sourcePeerKey, setSourcePeerKey] = useState<string>("");
  const [targetPeerKeys, setTargetPeerKeys] = useState<string[]>([]);
  const [fromMsgId, setFromMsgId] = useState<string>("");
  const [toMsgId, setToMsgId] = useState<string>("");
  const [dropAuthor, setDropAuthor] = useState(false);
  const [markRead, setMarkRead] = useState(true);
  const [delayMs, setDelayMs] = useState<string>("300");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [targetStates, setTargetStates] = useState<Record<string, TargetState>>({});
  const [running, setRunning] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const dialogsQ = useQuery({
    queryKey: ["forward-range-dialogs", accountId],
    queryFn: () => listDialogsFn({ data: { accountId, limit: 2000, withPhotos: true } }),
    enabled: !!accountId,
  });
  const dialogs: Dialog[] = (dialogsQ.data?.dialogs ?? []) as Dialog[];
  const titleOf = (key: string) =>
    dialogs.find((d) => d.peerKey === key)?.title ?? key;

  const validate = (): { fromN: number; toN: number } | null => {
    const fromN = Number(fromMsgId);
    const toN = Number(toMsgId);
    if (!accountId) { toast.error("Pick an account."); return null; }
    if (!sourcePeerKey) { toast.error("Pick a source chat."); return null; }
    if (targetPeerKeys.length === 0) { toast.error("Pick at least one target chat."); return null; }
    if (targetPeerKeys.includes(sourcePeerKey)) { toast.error("Target cannot equal source."); return null; }
    if (!Number.isFinite(fromN) || !Number.isFinite(toN) || fromN < 1 || toN < 1) {
      toast.error("Enter valid message IDs.");
      return null;
    }
    return { fromN, toN };
  };

  const openPreview = async () => {
    const v = validate();
    if (!v) return;
    setPreviewLoading(true);
    setPreviewData(null);
    setPreviewOpen(true);
    try {
      const res = await previewFn({
        data: { accountId, sourcePeerKey, fromMsgId: v.fromN, toMsgId: v.toN, sample: 60 },
      });
      setPreviewData(res as PreviewData);
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const startRun = async (resume = false) => {
    const v = validate();
    if (!v) return;
    setPreviewOpen(false);

    const resumeAfter: Record<string, number> = {};
    if (resume) {
      for (const k of targetPeerKeys) {
        const s = targetStates[k];
        if (s?.lastMsgId) resumeAfter[k] = s.lastMsgId;
      }
    } else {
      setLogs([]);
    }

    // Init/refresh target states
    setTargetStates((prev) => {
      const next: Record<string, TargetState> = {};
      for (const k of targetPeerKeys) {
        const existing = resume ? prev[k] : undefined;
        next[k] = existing
          ? { ...existing, status: "queued" }
          : { key: k, title: titleOf(k), ok: 0, fail: 0, total: 0, lastMsgId: 0, status: "queued" };
      }
      return next;
    });

    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      toast.error("Not signed in.");
      setRunning(false);
      return;
    }

    try {
      const res = await fetch("/api/public/forward-range-stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          accountId,
          sourcePeerKey,
          targetPeerKeys,
          fromMsgId: v.fromN,
          toMsgId: v.toN,
          dropAuthor,
          markRead,
          delayMs: Math.max(0, Math.min(60000, Number(delayMs) || 0)),
          resumeAfter,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Stream failed: ${res.status} ${txt}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evLine = raw.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!evLine || !dataLine) continue;
          const event = evLine.slice(7).trim();
          let data: any = {};
          try { data = JSON.parse(dataLine.slice(6)); } catch {}
          if (event === "log") {
            setLogs((prev) => [...prev, { level: data.level ?? "info", message: data.message ?? "", targetKey: data.targetKey }]);
          } else if (event === "plan") {
            setLogs((prev) => [...prev, { level: "info", message: `Plan: ${data.existing}/${data.total} real messages (${data.missing} gaps).` }]);
            setTargetStates((prev) => {
              const next = { ...prev };
              for (const k of Object.keys(next)) {
                next[k] = { ...next[k], total: Math.max(next[k].total, data.existing) };
              }
              return next;
            });
          } else if (event === "target-start") {
            setTargetStates((prev) => ({
              ...prev,
              [data.targetKey]: { ...prev[data.targetKey], status: "running" },
            }));
          } else if (event === "progress") {
            setTargetStates((prev) => ({
              ...prev,
              [data.targetKey]: {
                ...prev[data.targetKey],
                ok: data.ok,
                fail: data.fail,
                total: data.total,
                lastMsgId: data.lastMsgId,
                status: "running",
              },
            }));
          } else if (event === "target-done") {
            setTargetStates((prev) => ({
              ...prev,
              [data.targetKey]: {
                ...prev[data.targetKey],
                ok: data.ok,
                fail: data.fail,
                lastMsgId: data.lastMsgId,
                status: "done",
              },
            }));
          } else if (event === "aborted") {
            setTargetStates((prev) => {
              const next = { ...prev };
              for (const k of Object.keys(next)) {
                if (next[k].status === "running" || next[k].status === "queued") next[k].status = "aborted";
              }
              return next;
            });
          } else if (event === "end") {
            toast.success(data.aborted ? "Stopped. You can resume." : "Forwarding complete.");
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setLogs((prev) => [...prev, { level: "error", message: e?.message ?? String(e) }]);
        toast.error(e?.message ?? String(e));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stopRun = () => {
    abortRef.current?.abort();
  };

  const canResume = !running && Object.values(targetStates).some(
    (s) => (s.status === "aborted" || s.fail > 0 || (s.total > 0 && s.ok + s.fail < s.total)) && s.total > 0,
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !running && !previewOpen) {
      e.preventDefault();
      openPreview();
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6" onKeyDown={onKeyDown}>
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Forward className="h-6 w-6" /> Forward Range
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pick an account, choose a source chat, enter a message ID range, then choose a target chat. Press Enter to forward every message in the range.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1. Account</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger><SelectValue placeholder="Choose account…" /></SelectTrigger>
            <SelectContent>
              {accounts.map((a: any) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.first_name || a.username || a.phone}{a.username ? ` · @${a.username}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">2. Source chat</CardTitle>
          </CardHeader>
          <CardContent>
            {dialogsQ.isLoading && accountId && (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading chats…
              </div>
            )}
            {!accountId && <div className="text-sm text-muted-foreground">Pick an account first.</div>}
            {accountId && !dialogsQ.isLoading && (
              <ChatPicker
                label="From (source)"
                dialogs={dialogs}
                value={sourcePeerKey}
                onChange={setSourcePeerKey}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">3. Target chats (multiple)</CardTitle>
          </CardHeader>
          <CardContent>
            {!accountId && <div className="text-sm text-muted-foreground">Pick an account first.</div>}
            {accountId && (
              <MultiChatPicker
                dialogs={dialogs}
                values={targetPeerKeys}
                onChange={setTargetPeerKeys}
                excludeKey={sourcePeerKey}
                disabled={running}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">4. Message range</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid md:grid-cols-[1fr_auto_1fr_1fr] gap-3 items-end">
            <div>
              <Label>From message ID</Label>
              <Input inputMode="numeric" value={fromMsgId} onChange={(e) => setFromMsgId(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 120" />
            </div>
            <div className="hidden md:flex pb-2 justify-center text-muted-foreground"><ArrowRight className="h-4 w-4" /></div>
            <div>
              <Label>To message ID</Label>
              <Input inputMode="numeric" value={toMsgId} onChange={(e) => setToMsgId(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 260" />
            </div>
            <div>
              <Label>Delay between batches (ms)</Label>
              <Input inputMode="numeric" value={delayMs} onChange={(e) => setDelayMs(e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <div className="flex flex-wrap gap-4 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={dropAuthor} onCheckedChange={(v) => setDropAuthor(!!v)} />
              Remove “Forwarded from” tag
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={markRead} onCheckedChange={(v) => setMarkRead(!!v)} />
              Mark source as read first
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Tip: Tap message IDs in Telegram to copy them. Missing IDs (deleted / service messages) are skipped automatically. Max 5000 IDs per run.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              className="flex-1 min-w-[200px]"
              onClick={openPreview}
              disabled={running || !accountId || !sourcePeerKey || targetPeerKeys.length === 0 || !fromMsgId || !toMsgId}
            >
              <Forward className="h-4 w-4 mr-2" /> Preview & forward (Enter)
            </Button>
            {canResume && (
              <Button variant="secondary" onClick={() => startRun(true)} disabled={running}>
                <RotateCcw className="h-4 w-4 mr-2" /> Resume from last success
              </Button>
            )}
            {running && (
              <Button variant="destructive" onClick={stopRun}>
                <Square className="h-4 w-4 mr-2" /> Stop
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {Object.keys(targetStates).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.values(targetStates).map((s) => {
              const done = s.ok + s.fail;
              const pct = s.total > 0 ? Math.round((done / s.total) * 100) : 0;
              return (
                <div key={s.key} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div className="font-medium truncate">{s.title}</div>
                    <div className="text-xs text-muted-foreground shrink-0 ml-2">
                      <span className="text-green-500">{s.ok} sent</span>
                      {s.fail > 0 && <span className="text-red-500"> · {s.fail} failed</span>}
                      {s.total > 0 && <span> · {done}/{s.total}</span>}
                      {s.lastMsgId > 0 && <span> · last #{s.lastMsgId}</span>}
                      <span className="ml-2 uppercase text-[10px]">{s.status}</span>
                    </div>
                  </div>
                  <Progress value={pct} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {logs.length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Run log</CardTitle></CardHeader>
          <CardContent>
            <div className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs space-y-1">
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === "error"
                      ? "text-red-500"
                      : l.level === "warn"
                        ? "text-amber-500"
                        : l.level === "success"
                          ? "text-green-500"
                          : "text-muted-foreground"
                  }
                >
                  [{l.level}]{l.targetKey ? ` {${titleOf(l.targetKey)}}` : ""} {l.message}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={previewOpen} onOpenChange={(o) => !running && setPreviewOpen(o)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirm forward</DialogTitle>
          </DialogHeader>
          {previewLoading && (
            <div className="py-8 flex items-center justify-center text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Fetching range preview…
            </div>
          )}
          {!previewLoading && previewData && (
            <div className="space-y-3">
              <div className="text-sm">
                Forwarding <b>{previewData.existing}</b> real messages
                {" "}(of {previewData.total} IDs, {previewData.missing} gaps)
                {previewData.firstId && (
                  <> from #{previewData.firstId} → #{previewData.lastId}</>
                )}
                {" "}to <b>{targetPeerKeys.length}</b> chat{targetPeerKeys.length === 1 ? "" : "s"}.
              </div>
              <div className="rounded-md border bg-muted/30 max-h-72 overflow-auto text-xs divide-y">
                {previewData.sample.map((m) => (
                  <div key={m.id} className="px-2 py-1 flex gap-2">
                    <span className="font-mono text-muted-foreground w-16 shrink-0">#{m.id}</span>
                    <span className="uppercase text-[9px] text-muted-foreground w-14 shrink-0 pt-0.5">{m.kind}</span>
                    <span className="truncate">{m.excerpt}</span>
                  </div>
                ))}
                {previewData.sample.length === 0 && (
                  <div className="p-3 text-muted-foreground">No messages in range.</div>
                )}
                {previewData.existing > previewData.sample.length && (
                  <div className="px-2 py-1 text-muted-foreground italic">
                    …and {previewData.existing - previewData.sample.length} more
                  </div>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Targets: {targetPeerKeys.map((k) => titleOf(k)).join(", ")}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)} disabled={running}>Cancel</Button>
            <Button
              onClick={() => startRun(false)}
              disabled={previewLoading || !previewData || previewData.existing === 0 || running}
            >
              <Play className="h-4 w-4 mr-2" /> Forward now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}