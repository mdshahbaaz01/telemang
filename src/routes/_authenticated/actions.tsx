import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { listAccounts } from "@/lib/accounts.functions";
import { loadPoll, listActionRuns, deleteActionRun, clearActionRuns } from "@/lib/actions.functions";
import {
  createScheduledBroadcast,
  listScheduledBroadcasts,
  cancelScheduledBroadcast,
} from "@/lib/schedule.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { AdminGate } from "@/components/AdminGate";
import { AccountIdPaste } from "@/components/AccountIdPaste";
import { Square, Play, Paperclip, X, AlertTriangle, Copy, Trash2, RotateCw, Pencil, Clock, CalendarClock } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";

export const Route = createFileRoute("/_authenticated/actions")({
  validateSearch: (s: Record<string, unknown>) =>
    z
      .object({
        tab: z.enum(["react", "forward", "vote", "broadcast", "comment", "reply"]).optional(),
      })
      .parse(s),
  component: () => (
    <AdminGate>
      <ActionsPage />
    </AdminGate>
  ),
});

type Tab = "react" | "forward" | "vote" | "broadcast" | "comment" | "reply";

type BroadcastRow = { id: string; message: string; targets: string; accountId?: string; file?: File | null };
type ReplyRow = { id: string; message: string; accountId?: string; file?: File | null };
type SendMode = "per-account" | "all-ids";

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

function AttachmentField({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div>
      <Label>Attachment (optional)</Label>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          <span className="truncate">{file.name}</span>
          <span className="ml-auto text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => {
              onChange(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            aria-label="Remove attachment"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          <Paperclip className="mr-1 h-4 w-4" /> Attach file
        </Button>
      )}
      {file && (
        <p className="mt-1 text-xs text-muted-foreground">
          The message text above will be sent as the caption.
        </p>
      )}
    </div>
  );
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
  const search = Route.useSearch();
  const listAcc = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const listRunsFn = useServerFn(listActionRuns);
  const deleteRunFn = useServerFn(deleteActionRun);
  const clearRunsFn = useServerFn(clearActionRuns);
  const qc = useQueryClient();
  const runsQ = useQuery({ queryKey: ["action-runs"], queryFn: () => listRunsFn() });
  const [editingRun, setEditingRun] = useState<any | null>(null);

  const [tab, setTab] = useState<Tab>(search.tab ?? "react");
  const [source, setSource] = useState("");
  const [emoji, setEmoji] = useState("👍");
  const [customEmojiId, setCustomEmojiId] = useState("");
  const [targets, setTargets] = useState("");
  const [options, setOptions] = useState("0");
  const [pollInfo, setPollInfo] = useState<{
    question: string;
    answers: { text: string; voters: number; chosen: boolean }[];
    multipleChoice: boolean;
    closed: boolean;
    totalVoters: number;
    alreadyVoted: boolean;
    checkedAccountId: string;
  } | null>(null);
  const [pollSelected, setPollSelected] = useState<number[]>([]);
  const [pollLoading, setPollLoading] = useState(false);
  const [pollCheckAccountId, setPollCheckAccountId] = useState<string>("");
  const [showResults, setShowResults] = useState(false);
  const loadPollFn = useServerFn(loadPoll);
  const [minDelay, setMinDelay] = useState(1);
  const [maxDelay, setMaxDelay] = useState(2);
  const [rows, setRows] = useState<BroadcastRow[]>([
    { id: "broadcast-row-1", message: "", targets: "" },
  ]);
  const [replyRows, setReplyRows] = useState<ReplyRow[]>([
    { id: "reply-row-1", message: "" },
  ]);
  const [broadcastMode, setBroadcastMode] = useState<SendMode>("per-account");
  const [replyMode, setReplyMode] = useState<SendMode>("per-account");
  const [broadcastSelectedIds, setBroadcastSelectedIds] = useState<string[]>([]);
  const [replySelectedIds, setReplySelectedIds] = useState<string[]>([]);
  const [actionSelectedIds, setActionSelectedIds] = useState<string[]>([]);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<{ ok: number; fail: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [scheduledAt, setScheduledAt] = useState<string>("");
  const [scheduling, setScheduling] = useState(false);
  const listSchedFn = useServerFn(listScheduledBroadcasts);
  const createSchedFn = useServerFn(createScheduledBroadcast);
  const cancelSchedFn = useServerFn(cancelScheduledBroadcast);
  const schedulesQ = useQuery({
    queryKey: ["scheduled-broadcasts"],
    queryFn: () => listSchedFn(),
    refetchInterval: 15_000,
  });

  const uploadAttachment = async (file: File) => {
    const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
    const path = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    const { error } = await supabase.storage
      .from("action-attachments")
      .upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) throw new Error(error.message);
    return { path, filename: file.name, mimeType: file.type || undefined };
  };

  const accountList = accountsQ.data ?? [];
  const allAccountIds = useMemo(() => accountList.map((a) => a.id), [accountList]);
  const errorLogs = useMemo(() => logs.filter((l) => l.level === "error" || l.level === "warn"), [logs]);

  const addLog = (l: Omit<LogEntry, "ts">) =>
    setLogs((prev) => [{ ...l, ts: Date.now() }, ...prev].slice(0, 500));

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
        if (event === "start") addLog({ level: "info", message: `Run started: ${data.kind ?? "action"}` });
        else if (event === "log") addLog({ accountId: data.accountId, level: data.level ?? "info", target: data.target, message: data.message ?? "" });
        else if (event === "done") addLog({ accountId: data.accountId, level: data.fail ? "warn" : "info", message: `Account done — ok ${data.ok}, fail ${data.fail}` });
        else if (event === "end") {
          setTotals({ ok: data.ok ?? 0, fail: data.fail ?? 0 });
          const message = `Finished — ok ${data.ok}, fail ${data.fail}`;
          if (data.fail) toast.warning(message);
          else toast.success(message);
        }
        else if (event === "aborted") addLog({ level: "warn", message: data.message ?? "Stopped" });
      }
    }
  };

  const run = async (mode: "apply" | "clear" = "apply") => {
    const src = parseMessageLink(source);
    if (!src) {
      toast.error("Enter a valid message link (https://t.me/<chat>/<id>)");
      return;
    }
    if (allAccountIds.length === 0) {
      toast.error("No accounts available");
      return;
    }
    const runAccountIds =
      (tab === "react" || tab === "vote") && actionSelectedIds.length
        ? actionSelectedIds
        : allAccountIds;

    let op: unknown;
    if (tab === "react") {
      if (mode === "apply" && !emoji.trim() && !customEmojiId.trim()) return toast.error("Pick an emoji or custom emoji id");
      if (customEmojiId.trim() && !/^\d+$/.test(customEmojiId.trim())) return toast.error("Custom emoji document id must contain only digits");
      op = {
        kind: "react",
        source: src,
        emoji: emoji.trim() || "👍",
        ...(customEmojiId.trim() ? { customEmojiId: customEmojiId.trim() } : {}),
        mode,
      };
    } else if (tab === "forward") {
      const list = targets
        .split(/\r?\n|,/) 
        .map((s) => s.trim())
        .filter(Boolean);
      if (!list.length) return toast.error("Enter at least one destination");
      op = { kind: "forward", source: src, targets: list };
    } else if (tab === "vote") {
      const opts = pollSelected.length
        ? [...pollSelected].sort((a, b) => a - b)
        : options
            .split(/[,\s]+/)
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n >= 0);
      if (mode === "apply" && !opts.length) return toast.error("Pick at least one poll option");
      op = { kind: "vote", source: src, options: opts, mode };
    } else {
      // handled below in runBroadcast
      return;
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
          accountIds: runAccountIds,
          minDelay,
          maxDelay,
          op,
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

  const rerunFromParams = async (params: any) => {
    if (!params || !params.op) return toast.error("Run has no saved params");
    await streamRun(params);
    qc.invalidateQueries({ queryKey: ["action-runs"] });
  };

  const deleteRun = async (runId: string) => {
    if (!confirm("Delete this run and its logs?")) return;
    try {
      await deleteRunFn({ data: { runId } });
      qc.invalidateQueries({ queryKey: ["action-runs"] });
      toast.success("Run deleted");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const clearAllRuns = async () => {
    if (!confirm("Delete ALL runs and their logs? This cannot be undone.")) return;
    try {
      await clearRunsFn();
      qc.invalidateQueries({ queryKey: ["action-runs"] });
      toast.success("History cleared");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const streamRun = async (payload: unknown) => {
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
        body: JSON.stringify(payload),
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

  const runReply = async () => {
    const src = parseMessageLink(source);
    if (!src) return toast.error("Enter a valid message link");
    if (allAccountIds.length === 0) return toast.error("No accounts available");
    let cleaned: { accountId: string; message: string; attachment?: { path: string; filename: string; mimeType?: string } }[] = [];
    try {
      if (replyMode === "per-account") {
        const rows = replyRows.filter((r) => (r.accountId ?? "") && (r.message.trim() || r.file));
        if (!rows.length) return toast.error("Pick an account and add message or file for each row");
        cleaned = await Promise.all(rows.map(async (r) => ({
          accountId: r.accountId!,
          message: r.message.trim(),
          attachment: r.file ? await uploadAttachment(r.file) : undefined,
        })));
      } else {
        const rows = replyRows.filter((r) => r.message.trim() || r.file);
        if (!rows.length) return toast.error("Add at least one message or file");
        const uploads = await Promise.all(rows.map(async (r) => ({
          message: r.message.trim(),
          attachment: r.file ? await uploadAttachment(r.file) : undefined,
        })));
        const targetIds = replySelectedIds.length ? replySelectedIds : allAccountIds;
        if (!targetIds.length) return toast.error("Select at least one account");
        // Round-robin rows across selected accounts.
        cleaned = targetIds.map((accountId, i) => ({ accountId, ...uploads[i % uploads.length] }));
      }
    } catch (e) {
      return toast.error((e as Error).message);
    }
    await streamRun({
      accountIds: [],
      minDelay,
      maxDelay,
      op: { kind: "reply", source: src, viaDiscussion: tab === "comment", rows: cleaned },
    });
  };

  const buildBroadcastCleaned = async (): Promise<
    { accountId: string; message: string; targets: string[]; attachment?: { path: string; filename: string; mimeType?: string } }[] | null
  > => {
    const baseRows = rows
      .map((r) => ({
        accountId: r.accountId ?? "",
        message: r.message.trim(),
        targets: r.targets
          .split(/\r?\n|,/)
          .map((s) => s.trim())
          .filter(Boolean),
        file: r.file ?? null,
      }))
      .filter((r) => (r.message || r.file) && r.targets.length);
    if (!baseRows.length) {
      toast.error("Add at least one row with message/file and targets");
      return null;
    }
    try {
      const uploaded = await Promise.all(
        baseRows.map(async (r) => (r.file ? await uploadAttachment(r.file) : undefined)),
      );
      const withAtt = baseRows.map((r, i) => ({
        accountId: r.accountId,
        message: r.message,
        targets: r.targets,
        attachment: uploaded[i],
      }));
      if (broadcastMode === "per-account") {
        const c = withAtt.filter((r) => r.accountId);
        if (!c.length) {
          toast.error("Pick an account for each row");
          return null;
        }
        return c;
      }
      const targetIds = broadcastSelectedIds.length ? broadcastSelectedIds : allAccountIds;
      if (!targetIds.length) {
        toast.error("Select at least one account");
        return null;
      }
      return targetIds.flatMap((accountId) =>
        withAtt.map((r) => ({ accountId, message: r.message, targets: r.targets, attachment: r.attachment })),
      );
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  };

  const runBroadcast = async () => {
    if (allAccountIds.length === 0) {
      toast.error("No accounts available");
      return;
    }
    const cleaned = await buildBroadcastCleaned();
    if (!cleaned) return;

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
          accountIds: [],
          minDelay,
          maxDelay,
          op: { kind: "broadcast", rows: cleaned },
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

  const scheduleBroadcast = async () => {
    if (!scheduledAt) {
      toast.error("Pick a schedule time (with seconds)");
      return;
    }
    // datetime-local returns local wall-clock without a timezone — convert to ISO.
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) return toast.error("Invalid schedule time");
    if (when.getTime() < Date.now() + 5_000) {
      return toast.error("Schedule at least 5 seconds in the future");
    }
    if (allAccountIds.length === 0) {
      toast.error("No accounts available");
      return;
    }
    const cleaned = await buildBroadcastCleaned();
    if (!cleaned) return;
    setScheduling(true);
    try {
      const res = await createSchedFn({
        data: {
          scheduledAt: when.toISOString(),
          rows: cleaned,
          minDelay,
          maxDelay,
        },
      });
      toast.success(`Scheduled for ${when.toLocaleString()} (fires within ±1s)`);
      setScheduledAt("");
      await qc.invalidateQueries({ queryKey: ["scheduled-broadcasts"] });
      return res;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScheduling(false);
    }
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
          <div className="mb-2 text-sm font-medium">
            All accounts ({accountList.length}) will be used
          </div>
          <div className="max-h-[70vh] space-y-1 overflow-auto">
            {accountList.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm">
                <span className="truncate">
                  {a.first_name || a.username || a.phone}
                </span>
              </div>
            ))}
            {accountList.length === 0 && (
              <p className="text-xs text-muted-foreground">No accounts yet.</p>
            )}
          </div>
        </aside>

        {/* Main panel */}
        <section className="space-y-4">
          <div className="flex gap-2 border-b border-border">
            {(["react", "forward", "vote", "broadcast", "comment", "reply"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm capitalize ${
                  tab === t
                    ? "border-b-2 border-primary font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {t === "react" ? "Reactions" : t === "forward" ? "Forwarder" : t === "vote" ? "Poll voter" : t === "broadcast" ? "Broadcast" : t === "comment" ? "Comment" : "Reply"}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            {tab !== "broadcast" && <div>
              <Label>Source message link</Label>
              <Input
                placeholder="https://t.me/channel/12345"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Supports public (@name) and private (c/&lt;id&gt;) chats.
              </p>
            </div>}

            {tab === "react" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Emoji</Label>
                    <Input
                      value={emoji}
                      onChange={(e) => setEmoji(e.target.value)}
                      maxLength={20}
                    />
                  </div>
                  <div>
                    <Label>Custom emoji document id (optional)</Label>
                    <Input
                      value={customEmojiId}
                      onChange={(e) => setCustomEmojiId(e.target.value)}
                      placeholder="e.g. 5312016608254762256"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Overrides emoji. Use this to react with any premium/custom emoji when the channel restricts standard ones.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Any previous reaction from the same account is cleared automatically before the new one is applied. Use "Take back" to remove reactions without adding a new one.
                </p>
                <DelayFields
                  minDelay={minDelay}
                  maxDelay={maxDelay}
                  setMin={setMinDelay}
                  setMax={setMaxDelay}
                />
                <AccountMultiPicker
                  accountList={accountList}
                  selectedIds={actionSelectedIds}
                  setSelectedIds={setActionSelectedIds}
                  allAccountIds={allAccountIds}
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
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pollLoading}
                    onClick={async () => {
                      const src = parseMessageLink(source);
                      if (!src) return toast.error("Enter a valid message link first");
                      setPollLoading(true);
                      try {
                        const info = await loadPollFn({
                          data: {
                            chat: src.chat,
                            msgId: src.msgId,
                            ...(pollCheckAccountId ? { accountId: pollCheckAccountId } : {}),
                          },
                        });
                        setPollInfo(info);
                        setPollSelected(info.answers.map((a, i) => (a.chosen ? i : -1)).filter((i) => i >= 0));
                        setShowResults(false);
                        if (info.closed) toast.warning("Poll is closed");
                      } catch (e) {
                        toast.error((e as Error).message);
                      } finally {
                        setPollLoading(false);
                      }
                    }}
                  >
                    {pollLoading ? "Loading…" : "Load poll"}
                  </Button>
                  {pollInfo && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pollLoading}
                        onClick={async () => {
                          const src = parseMessageLink(source);
                          if (!src) return;
                          setPollLoading(true);
                          try {
                            const info = await loadPollFn({
                              data: {
                                chat: src.chat,
                                msgId: src.msgId,
                                ...(pollCheckAccountId ? { accountId: pollCheckAccountId } : {}),
                              },
                            });
                            setPollInfo(info);
                            setShowResults(true);
                          } catch (e) {
                            toast.error((e as Error).message);
                          } finally {
                            setPollLoading(false);
                          }
                        }}
                      >
                        {showResults ? "Refresh results" : "View results"}
                      </Button>
                    </>
                  )}
                  {pollInfo && (
                    <span className="text-xs text-muted-foreground">
                      {pollInfo.multipleChoice ? "Multi-choice" : "Single-choice"}
                      {pollInfo.closed ? " · closed" : ""}
                      {pollInfo.totalVoters ? ` · ${pollInfo.totalVoters} vote${pollInfo.totalVoters === 1 ? "" : "s"}` : ""}
                    </span>
                  )}
                </div>
                <div>
                  <Label>Check vote status from account (optional)</Label>
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
                    value={pollCheckAccountId}
                    onChange={(e) => setPollCheckAccountId(e.target.value)}
                  >
                    <option value="">— First active account —</option>
                    {accountList.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.first_name || a.username || a.phone}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    "Already voted" status and per-option "chosen" reflects this account.
                  </p>
                </div>
                {pollInfo?.alreadyVoted && (
                  <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                    This account already voted for {pollInfo.answers.filter((a) => a.chosen).map((a) => `"${a.text}"`).join(", ")}. Running "Vote" again will retract it and cast the new selection.
                  </div>
                )}
                {pollInfo ? (
                  <div className="rounded-md border border-border p-3 space-y-2">
                    {pollInfo.question && (
                      <div className="text-sm font-medium">{pollInfo.question}</div>
                    )}
                    <div className="space-y-1">
                      {pollInfo.answers.map((a, i) => {
                        const checked = pollSelected.includes(i);
                        const pct = pollInfo.totalVoters > 0
                          ? Math.round((a.voters / pollInfo.totalVoters) * 100)
                          : 0;
                        return (
                          <label key={i} className={`flex items-start gap-2 text-sm rounded px-2 py-1 hover:bg-muted/40 ${a.chosen ? "bg-primary/5" : ""}`}>
                            <input
                              type={pollInfo.multipleChoice ? "checkbox" : "radio"}
                              name="poll-option"
                              checked={checked}
                              onChange={(e) => {
                                if (pollInfo.multipleChoice) {
                                  setPollSelected((prev) =>
                                    e.target.checked ? [...prev, i] : prev.filter((x) => x !== i),
                                  );
                                } else {
                                  setPollSelected([i]);
                                }
                              }}
                            />
                            <span className="text-xs text-muted-foreground w-6">#{i}</span>
                            <span className="flex-1">
                              {a.text}
                              {a.chosen && <span className="ml-1 text-xs text-primary">✓ your vote</span>}
                            </span>
                            {(showResults || pollInfo.alreadyVoted) && (
                              <span className="ml-2 flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                                <span className="w-16 h-1.5 rounded bg-muted overflow-hidden">
                                  <span className="block h-full bg-primary" style={{ width: `${pct}%` }} />
                                </span>
                                <span className="w-14 text-right tabular-nums">{a.voters} · {pct}%</span>
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div>
                    <Label>Option indexes (0-based, comma-separated)</Label>
                    <Input
                      value={options}
                      onChange={(e) => setOptions(e.target.value)}
                      placeholder="0 or 0,2 — or click Load poll above"
                    />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Any previous vote from the same account is retracted automatically before the new one is cast. Use "Take back" to only retract without voting again.
                </p>
                <DelayFields
                  minDelay={minDelay}
                  maxDelay={maxDelay}
                  setMin={setMinDelay}
                  setMax={setMaxDelay}
                />
                <AccountMultiPicker
                  accountList={accountList}
                  selectedIds={actionSelectedIds}
                  setSelectedIds={setActionSelectedIds}
                  allAccountIds={allAccountIds}
                />
              </>
            )}

            {tab === "broadcast" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setBroadcastMode("per-account")}
                    className={`rounded border px-3 py-1 text-xs ${broadcastMode === "per-account" ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground"}`}
                  >
                    Per-account rows
                  </button>
                  <button
                    type="button"
                    onClick={() => setBroadcastMode("all-ids")}
                    className={`rounded border px-3 py-1 text-xs ${broadcastMode === "all-ids" ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground"}`}
                  >
                    Same message from all IDs
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {broadcastMode === "per-account"
                    ? "Each row: the chosen account sends its message to all listed targets. Rows run in parallel — multiple accounts can post different messages into the same group at the same time, or one account can spray one message across many groups."
                    : "Every row is sent from every selected account. Same message goes out from all picked IDs in parallel."}
                </p>
                {broadcastMode === "all-ids" && (
                  <div className="rounded-md border border-border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label className="mr-auto">Send from accounts</Label>
                      <button
                        type="button"
                        className="text-xs underline text-muted-foreground"
                        onClick={() => setBroadcastSelectedIds(allAccountIds)}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="text-xs underline text-muted-foreground"
                        onClick={() => setBroadcastSelectedIds([])}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="max-h-48 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {accountList.map((a) => {
                        const checked = broadcastSelectedIds.includes(a.id);
                        return (
                          <label key={a.id} className="flex items-center gap-2 text-sm rounded px-2 py-1 hover:bg-muted/40">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setBroadcastSelectedIds((ids) =>
                                  e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id),
                                )
                              }
                            />
                            <span className="truncate">{a.first_name || a.username || a.phone}</span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {broadcastSelectedIds.length
                        ? `${broadcastSelectedIds.length} account(s) selected`
                        : `None selected — will use all ${allAccountIds.length} account(s)`}
                    </p>
                    <AccountIdPaste
                      accounts={accountList}
                      onSelect={(ids) =>
                        setBroadcastSelectedIds((prev) => Array.from(new Set([...prev, ...ids])))
                      }
                    />
                  </div>
                )}
                {rows.map((row, idx) => (
                  <div key={row.id} className="rounded-md border border-border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-medium text-muted-foreground">Row {idx + 1}</div>
                      <button
                        type="button"
                        className="ml-auto text-xs text-destructive underline"
                        onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
                        disabled={rows.length === 1}
                      >
                        Remove
                      </button>
                    </div>
                    {broadcastMode === "per-account" && (
                      <div>
                        <Label>Account</Label>
                        <select
                          className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
                          value={row.accountId ?? ""}
                          onChange={(e) =>
                            setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, accountId: e.target.value } : r)))
                          }
                        >
                          <option value="">— Pick account —</option>
                          {accountList.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.first_name || a.username || a.phone}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <Label>Message</Label>
                      <Textarea
                        rows={3}
                        value={row.message}
                        onChange={(e) =>
                          setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, message: e.target.value } : r)))
                        }
                        placeholder="Text to send…"
                      />
                    </div>
                    <div>
                      <Label>Targets (users, groups, channels — one per line)</Label>
                      <Textarea
                        rows={3}
                        value={row.targets}
                        onChange={(e) =>
                          setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, targets: e.target.value } : r)))
                        }
                        placeholder="@username&#10;@mygroup&#10;https://t.me/channel"
                      />
                    </div>
                    <AttachmentField
                      file={row.file ?? null}
                      onChange={(f) =>
                        setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, file: f } : r)))
                      }
                    />
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setRows((rs) => [...rs, { id: crypto.randomUUID(), message: "", targets: "" }])
                    }
                  >
                    + Add row
                  </Button>
                </div>
                <DelayFields
                  minDelay={minDelay}
                  maxDelay={maxDelay}
                  setMin={setMinDelay}
                  setMax={setMaxDelay}
                />
              </div>
            )}

            {(tab === "reply" || tab === "comment") && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setReplyMode("per-account")}
                    className={`rounded border px-3 py-1 text-xs ${replyMode === "per-account" ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground"}`}
                  >
                    Per-account rows
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplyMode("all-ids")}
                    className={`rounded border px-3 py-1 text-xs ${replyMode === "all-ids" ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground"}`}
                  >
                    Same message from all IDs
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tab === "comment"
                    ? "Comment under a channel post — reply lands in the channel's linked discussion group."
                    : "Reply directly to a message inside a group or chat."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {replyMode === "per-account"
                    ? `Each row: the chosen account sends this ${tab}. Rows run in parallel — different accounts can post different ${tab}s on the same post.`
                    : `Same ${tab} text goes out from every selected account (round-robin if you add multiple rows).`}
                </p>
                {replyMode === "all-ids" && (
                  <div className="rounded-md border border-border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label className="mr-auto">Send from accounts</Label>
                      <button
                        type="button"
                        className="text-xs underline text-muted-foreground"
                        onClick={() => setReplySelectedIds(allAccountIds)}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="text-xs underline text-muted-foreground"
                        onClick={() => setReplySelectedIds([])}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="max-h-48 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {accountList.map((a) => {
                        const checked = replySelectedIds.includes(a.id);
                        return (
                          <label key={a.id} className="flex items-center gap-2 text-sm rounded px-2 py-1 hover:bg-muted/40">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setReplySelectedIds((ids) =>
                                  e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id),
                                )
                              }
                            />
                            <span className="truncate">{a.first_name || a.username || a.phone}</span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {replySelectedIds.length
                        ? `${replySelectedIds.length} account(s) selected`
                        : `None selected — will use all ${allAccountIds.length} account(s)`}
                    </p>
                    <AccountIdPaste
                      accounts={accountList}
                      onSelect={(ids) =>
                        setReplySelectedIds((prev) => Array.from(new Set([...prev, ...ids])))
                      }
                    />
                  </div>
                )}
                {replyRows.map((row, idx) => (
                  <div key={row.id} className="rounded-md border border-border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-medium text-muted-foreground">Row {idx + 1}</div>
                      <button
                        type="button"
                        className="ml-auto text-xs text-destructive underline"
                        onClick={() => setReplyRows((rs) => rs.filter((r) => r.id !== row.id))}
                        disabled={replyRows.length === 1}
                      >
                        Remove
                      </button>
                    </div>
                    {replyMode === "per-account" && (
                      <div>
                        <Label>Account</Label>
                        <select
                          className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
                          value={row.accountId ?? ""}
                          onChange={(e) =>
                            setReplyRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, accountId: e.target.value } : r)))
                          }
                        >
                          <option value="">— Pick account —</option>
                          {accountList.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.first_name || a.username || a.phone}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <Label>Message</Label>
                      <Textarea
                        rows={2}
                        value={row.message}
                        onChange={(e) =>
                          setReplyRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, message: e.target.value } : r)))
                        }
                        placeholder="Reply text…"
                      />
                    </div>
                    <AttachmentField
                      file={row.file ?? null}
                      onChange={(f) =>
                        setReplyRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, file: f } : r)))
                      }
                    />
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setReplyRows((rs) => [...rs, { id: crypto.randomUUID(), message: "" }])}
                  >
                    + Add row
                  </Button>
                </div>
                <DelayFields minDelay={minDelay} maxDelay={maxDelay} setMin={setMinDelay} setMax={setMaxDelay} />
              </div>
            )}

            <div className="flex gap-2 pt-2">
              {tab === "broadcast" ? (
                <Button onClick={runBroadcast} disabled={running}>
                  <Play className="mr-1 h-4 w-4" /> Run broadcast ({rows.length} row{rows.length === 1 ? "" : "s"})
                </Button>
              ) : (tab === "reply" || tab === "comment") ? (
                <Button onClick={runReply} disabled={running}>
                  <Play className="mr-1 h-4 w-4" /> Send {replyRows.length} {tab}{replyRows.length === 1 ? "" : "s"}
                </Button>
              ) : (
                <Button
                  onClick={() => run("apply")}
                  disabled={
                    running ||
                    allAccountIds.length === 0 ||
                    (tab === "vote" && !!pollInfo?.closed)
                  }
                >
                  <Play className="mr-1 h-4 w-4" />
                  {tab === "react" ? "React" : tab === "vote" ? "Vote" : "Run"} on {allAccountIds.length} account{allAccountIds.length === 1 ? "" : "s"}
                </Button>
              )}
              {(tab === "react" || tab === "vote") && (
                <Button
                  variant="outline"
                  onClick={() => run("clear")}
                  disabled={running || allAccountIds.length === 0}
                  title={tab === "react" ? "Remove reaction from selected accounts" : "Retract vote from selected accounts"}
                >
                  <RotateCw className="mr-1 h-4 w-4" /> Take back
                </Button>
              )}
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

          {errorLogs.length > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <div className="mr-auto text-sm font-medium">Error log ({errorLogs.length})</div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const text = errorLogs
                      .map((l) => {
                        const acc = accountList.find((a) => a.id === l.accountId);
                        const who = acc ? acc.first_name || acc.username || acc.phone : l.accountId ?? "—";
                        return `${new Date(l.ts).toLocaleString()} [${l.level}] [${who}]${l.target ? ` ${l.target}` : ""} — ${l.message}`;
                      })
                      .join("\n");
                    void navigator.clipboard.writeText(text);
                    toast.success("Error log copied");
                  }}
                >
                  <Copy className="mr-1 h-4 w-4" /> Copy
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setLogs([])}>
                  <Trash2 className="mr-1 h-4 w-4" /> Clear
                </Button>
              </div>
              <div className="max-h-52 space-y-1 overflow-auto font-mono text-xs">
                {errorLogs.map((l, i) => {
                  const acc = accountList.find((a) => a.id === l.accountId);
                  const who = acc ? acc.first_name || acc.username || acc.phone : l.accountId ? l.accountId.slice(0, 8) : "—";
                  return (
                    <div key={`${l.ts}-${i}`} className={l.level === "error" ? "text-destructive" : "text-yellow-600 dark:text-yellow-400"}>
                      <span className="text-muted-foreground">
                        {new Date(l.ts).toLocaleTimeString()} [{who}]
                      </span>{" "}
                      {l.target ? <span className="text-muted-foreground">{l.target} —</span> : null} {l.message}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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

          <HistorySection
            runs={runsQ.data ?? []}
            accountList={accountList}
            loading={runsQ.isLoading}
            onRerun={rerunFromParams}
            onEdit={(r) => setEditingRun(r)}
            onDelete={deleteRun}
            onRefresh={() => qc.invalidateQueries({ queryKey: ["action-runs"] })}
            onClearAll={clearAllRuns}
          />
        </section>
      </div>

      {editingRun && (
        <EditRunDialog
          run={editingRun}
          accountList={accountList}
          onClose={() => setEditingRun(null)}
          onSave={async (newParams: any) => {
            setEditingRun(null);
            await rerunFromParams(newParams);
          }}
        />
      )}
    </main>
  );
}

type Account = { id: string; phone: string | null; username: string | null; first_name: string | null };

function AccountMultiPicker({
  accountList,
  selectedIds,
  setSelectedIds,
  allAccountIds,
}: {
  accountList: Account[];
  selectedIds: string[];
  setSelectedIds: (updater: string[] | ((prev: string[]) => string[])) => void;
  allAccountIds: string[];
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Label className="mr-auto">Send from accounts</Label>
        <button
          type="button"
          className="text-xs underline text-muted-foreground"
          onClick={() => setSelectedIds(allAccountIds)}
        >
          Select all
        </button>
        <button
          type="button"
          className="text-xs underline text-muted-foreground"
          onClick={() => setSelectedIds([])}
        >
          Clear
        </button>
      </div>
      <div className="max-h-48 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-1">
        {accountList.map((a) => {
          const checked = selectedIds.includes(a.id);
          return (
            <label key={a.id} className="flex items-center gap-2 text-sm rounded px-2 py-1 hover:bg-muted/40">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) =>
                  setSelectedIds((ids) =>
                    e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id),
                  )
                }
              />
              <span className="truncate">{a.first_name || a.username || a.phone}</span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {selectedIds.length
          ? `${selectedIds.length} account(s) selected`
          : `None selected — will use all ${allAccountIds.length} account(s)`}
      </p>
      <AccountIdPaste
        accounts={accountList}
        onSelect={(ids) =>
          setSelectedIds((prev) => Array.from(new Set([...prev, ...ids])))
        }
      />
    </div>
  );
}

function accountLabel(a?: Account | null) {
  if (!a) return "—";
  return a.first_name || a.username || a.phone || a.id.slice(0, 8);
}

function summarizeRun(run: any): string {
  const p = run?.params?.op ?? run?.params ?? {};
  const kind = run?.kind ?? p.kind;
  const src = p.source ? `${p.source.chat}/${p.source.msgId}` : "";
  if (kind === "react") return `React ${p.emoji ?? ""} · ${src}`;
  if (kind === "vote") return `Vote [${(p.options ?? []).join(",")}] · ${src}`;
  if (kind === "forward") return `Forward · ${src} → ${(p.targets ?? []).length} target(s)`;
  if (kind === "broadcast") {
    const rows = p.rows ?? [];
    const links = rows.reduce((n: number, r: any) => n + (r.targets?.length ?? 0), 0);
    return `Broadcast · ${rows.length} row(s) · ${links} link(s)`;
  }
  if (kind === "reply") {
    return `Reply · ${src} · ${(p.rows ?? []).length} row(s)`;
  }
  return String(kind ?? "run");
}

function HistorySection({
  runs,
  accountList,
  loading,
  onRerun,
  onEdit,
  onDelete,
  onRefresh,
  onClearAll,
}: {
  runs: any[];
  accountList: Account[];
  loading: boolean;
  onRerun: (params: any) => void;
  onEdit: (run: any) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onClearAll: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="mr-auto text-sm font-medium">History ({runs.length})</div>
        <Button size="sm" variant="outline" onClick={onRefresh}>
          <RotateCw className="mr-1 h-3.5 w-3.5" /> Refresh
        </Button>
        <Button size="sm" variant="destructive" onClick={onClearAll} disabled={runs.length === 0}>
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear history
        </Button>
      </div>
      {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {!loading && runs.length === 0 && (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      )}
      <div className="space-y-2">
        {runs.map((r) => {
          const t = r.totals ?? {};
          const ok = t.ok ?? 0;
          const fail = t.fail ?? 0;
          return (
            <div key={r.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {r.kind}
                </span>
                <span className="text-sm font-medium">{summarizeRun(r)}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleString()}
                </span>
                <span
                  className={`ml-auto text-xs ${
                    r.status === "stopped"
                      ? "text-yellow-600"
                      : r.status === "running"
                        ? "text-primary"
                        : "text-muted-foreground"
                  }`}
                >
                  {r.status} · ok {ok} · fail {fail}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => onRerun(r.params)}>
                  <Play className="mr-1 h-3.5 w-3.5" /> Re-run
                </Button>
                <Button size="sm" variant="outline" onClick={() => onEdit(r)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                </Button>
                <Button size="sm" variant="outline" onClick={() => onDelete(r.id)}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function linkFromSource(src: { chat: string; msgId: number } | undefined) {
  if (!src) return "";
  return `https://t.me/${src.chat}/${src.msgId}`;
}

function EditRunDialog({
  run,
  accountList,
  onClose,
  onSave,
}: {
  run: any;
  accountList: Account[];
  onClose: () => void;
  onSave: (params: any) => void;
}) {
  const initial = run.params ?? {};
  const op = initial.op ?? {};
  const kind: Tab = op.kind;

  const [minDelay, setMinDelay] = useState<number>(initial.minDelay ?? 1);
  const [maxDelay, setMaxDelay] = useState<number>(initial.maxDelay ?? 2);
  const [sourceUrl, setSourceUrl] = useState<string>(linkFromSource(op.source));
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(
    initial.accountIds ?? [],
  );
  const [forwardTargets, setForwardTargets] = useState<string>(
    (op.targets ?? []).join("\n"),
  );
  const [emoji, setEmoji] = useState<string>(op.emoji ?? "👍");
  const [voteOptions, setVoteOptions] = useState<string>(
    (op.options ?? []).join(","),
  );
  const [bRows, setBRows] = useState<
    { id: string; accountId: string; message: string; targets: string }[]
  >(
    (op.rows ?? []).map((r: any, i: number) => ({
      id: `br-${i}-${crypto.randomUUID()}`,
      accountId: r.accountId ?? "",
      message: r.message ?? "",
      targets: (r.targets ?? []).join("\n"),
    })),
  );
  const [rRows, setRRows] = useState<
    { id: string; accountId: string; message: string }[]
  >(
    (op.rows ?? []).map((r: any, i: number) => ({
      id: `rr-${i}-${crypto.randomUUID()}`,
      accountId: r.accountId ?? "",
      message: r.message ?? "",
    })),
  );
  const [viaDiscussion, setViaDiscussion] = useState<boolean>(
    op.viaDiscussion !== false,
  );

  const toggleAcc = (id: string) =>
    setSelectedAccounts((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const save = () => {
    const src = parseMessageLink(sourceUrl);
    let newOp: any;
    if (kind === "react") {
      if (!src) return toast.error("Valid source link required");
      newOp = { ...op, source: src, emoji: emoji.trim() || "👍" };
    } else if (kind === "vote") {
      if (!src) return toast.error("Valid source link required");
      const opts = voteOptions
        .split(/[,\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0);
      if (!opts.length) return toast.error("Pick at least one option");
      newOp = { ...op, source: src, options: opts };
    } else if (kind === "forward") {
      if (!src) return toast.error("Valid source link required");
      const t = forwardTargets
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!t.length) return toast.error("Add at least one destination");
      newOp = { ...op, source: src, targets: t };
    } else if (kind === "broadcast") {
      const rows = bRows
        .map((r) => ({
          accountId: r.accountId,
          message: r.message.trim(),
          targets: r.targets
            .split(/\r?\n|,/)
            .map((s) => s.trim())
            .filter(Boolean),
        }))
        .filter((r) => r.accountId && r.targets.length && r.message);
      if (!rows.length)
        return toast.error("Each row needs account, message, and targets");
      newOp = { kind: "broadcast", rows };
    } else if (kind === "reply") {
      if (!src) return toast.error("Valid source link required");
      const rows = rRows
        .map((r) => ({ accountId: r.accountId, message: r.message.trim() }))
        .filter((r) => r.accountId && r.message);
      if (!rows.length) return toast.error("Each row needs account and message");
      newOp = { kind: "reply", source: src, viaDiscussion, rows };
    } else {
      return toast.error("Unknown kind");
    }
    const needsAccountIds = kind === "react" || kind === "vote" || kind === "forward";
    const accountIds = needsAccountIds
      ? selectedAccounts.length
        ? selectedAccounts
        : accountList.map((a) => a.id)
      : [];
    onSave({ accountIds, minDelay, maxDelay, op: newOp });
  };

  const showAccountsPicker = kind === "react" || kind === "vote" || kind === "forward";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit run · {kind}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {kind !== "broadcast" && (
            <div>
              <Label>Source message link</Label>
              <Input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://t.me/channel/12345"
              />
            </div>
          )}

          {kind === "react" && (
            <div>
              <Label>Emoji</Label>
              <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} />
            </div>
          )}

          {kind === "vote" && (
            <div>
              <Label>Option indexes (comma-separated)</Label>
              <Input value={voteOptions} onChange={(e) => setVoteOptions(e.target.value)} />
            </div>
          )}

          {kind === "forward" && (
            <div>
              <Label>Destinations (one per line)</Label>
              <Textarea
                rows={4}
                value={forwardTargets}
                onChange={(e) => setForwardTargets(e.target.value)}
              />
            </div>
          )}

          {kind === "broadcast" && (
            <div className="space-y-2">
              {bRows.map((row, idx) => (
                <div key={row.id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center">
                    <span className="text-xs font-medium text-muted-foreground">Row {idx + 1}</span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-destructive underline"
                      onClick={() => setBRows((rs) => rs.filter((r) => r.id !== row.id))}
                    >
                      Remove row
                    </button>
                  </div>
                  <div>
                    <Label>Account</Label>
                    <select
                      className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
                      value={row.accountId}
                      onChange={(e) =>
                        setBRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, accountId: e.target.value } : r)))
                      }
                    >
                      <option value="">— Pick account —</option>
                      {accountList.map((a) => (
                        <option key={a.id} value={a.id}>
                          {accountLabel(a)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>Message</Label>
                    <Textarea
                      rows={2}
                      value={row.message}
                      onChange={(e) =>
                        setBRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, message: e.target.value } : r)))
                      }
                    />
                  </div>
                  <div>
                    <Label>Targets / links (one per line)</Label>
                    <Textarea
                      rows={3}
                      value={row.targets}
                      onChange={(e) =>
                        setBRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, targets: e.target.value } : r)))
                      }
                    />
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setBRows((rs) => [
                    ...rs,
                    { id: `br-${crypto.randomUUID()}`, accountId: "", message: "", targets: "" },
                  ])
                }
              >
                + Add row
              </Button>
            </div>
          )}

          {kind === "reply" && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={viaDiscussion}
                  onChange={(e) => setViaDiscussion(e.target.checked)}
                />
                Comment under channel post (via discussion group)
              </label>
              {rRows.map((row, idx) => (
                <div key={row.id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center">
                    <span className="text-xs font-medium text-muted-foreground">Row {idx + 1}</span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-destructive underline"
                      onClick={() => setRRows((rs) => rs.filter((r) => r.id !== row.id))}
                    >
                      Remove row
                    </button>
                  </div>
                  <div>
                    <Label>Account</Label>
                    <select
                      className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
                      value={row.accountId}
                      onChange={(e) =>
                        setRRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, accountId: e.target.value } : r)))
                      }
                    >
                      <option value="">— Pick account —</option>
                      {accountList.map((a) => (
                        <option key={a.id} value={a.id}>
                          {accountLabel(a)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>Message</Label>
                    <Textarea
                      rows={2}
                      value={row.message}
                      onChange={(e) =>
                        setRRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, message: e.target.value } : r)))
                      }
                    />
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setRRows((rs) => [
                    ...rs,
                    { id: `rr-${crypto.randomUUID()}`, accountId: "", message: "" },
                  ])
                }
              >
                + Add row
              </Button>
            </div>
          )}

          {showAccountsPicker && (
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Label className="mr-auto">Send from accounts</Label>
                <button
                  type="button"
                  className="text-xs underline text-muted-foreground"
                  onClick={() => setSelectedAccounts(accountList.map((a) => a.id))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="text-xs underline text-muted-foreground"
                  onClick={() => setSelectedAccounts([])}
                >
                  Clear
                </button>
              </div>
              <div className="grid max-h-48 grid-cols-1 gap-1 overflow-auto sm:grid-cols-2">
                {accountList.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40">
                    <input
                      type="checkbox"
                      checked={selectedAccounts.includes(a.id)}
                      onChange={() => toggleAcc(a.id)}
                    />
                    <span className="truncate">{accountLabel(a)}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {selectedAccounts.length
                  ? `${selectedAccounts.length} account(s) selected`
                  : `None selected — will use all ${accountList.length} account(s)`}
              </p>
              <AccountIdPaste
                accounts={accountList}
                onSelect={(ids) =>
                  setSelectedAccounts((prev) => Array.from(new Set([...prev, ...ids])))
                }
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Min delay (s)</Label>
              <Input type="number" value={minDelay} onChange={(e) => setMinDelay(Number(e.target.value))} />
            </div>
            <div>
              <Label>Max delay (s)</Label>
              <Input type="number" value={maxDelay} onChange={(e) => setMaxDelay(Number(e.target.value))} />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save}>
              <Play className="mr-1 h-4 w-4" /> Save & Run
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}