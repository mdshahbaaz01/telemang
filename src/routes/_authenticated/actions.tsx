import { Loader } from "@/components/ui/loader";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { listAccounts } from "@/lib/accounts.functions";
import { loadPoll, listActionRuns, deleteActionRun, clearActionRuns } from "@/lib/actions.functions";
import { precheckBroadcastTargets, type PrecheckResult } from "@/lib/precheck-targets.functions";
import {
  getBroadcastReplies,
  refreshReplyThread,
  pressInlineButton,
} from "@/lib/broadcast-replies.functions";
import {
  createScheduledBroadcast,
  listScheduledBroadcasts,
  cancelScheduledBroadcast,
  getScheduleReport,
  clearScheduledHistory,
} from "@/lib/schedule.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { AdminGate } from "@/components/AdminGate";
import { AccountIdPaste } from "@/components/AccountIdPaste";
import { Square, Play, Paperclip, X, AlertTriangle, Copy, Trash2, RotateCw, Pencil, Clock, CalendarClock, Eye, EyeOff, MessageSquareReply, ExternalLink, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { ChatIdChip } from "@/components/chat/ChatIdChip";
import { MessagePreview } from "@/components/MessagePreview";
import { TargetsPicker } from "@/components/TargetsPicker";

function RangeApply({
  label,
  accountsCount,
  onApply,
}: {
  label: string;
  accountsCount: number;
  onApply: (start: number, end: number, template: string, appendNumbers: boolean) => void;
}) {
  const [range, setRange] = useState("");
  const [template, setTemplate] = useState("");
  const [appendNumbers, setAppendNumbers] = useState(true);
  const parsed = (() => {
    const m = range.trim().match(/^(\d+)\s*[-,\s]\s*(\d+)$/);
    if (!m) return null;
    const a = Math.max(1, parseInt(m[1], 10));
    const b = Math.max(a, parseInt(m[2], 10));
    return { start: a, end: Math.min(b, accountsCount) };
  })();
  return (
    <div className="rounded-md border border-dashed border-border p-3 space-y-2 bg-muted/20">
      <div className="flex items-center gap-2">
        <Label className="text-xs">Range auto-fill (optional)</Label>
        <span className="text-[10px] text-muted-foreground ml-auto">{accountsCount} account(s) available</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-28"
          placeholder="e.g. 1-6"
          value={range}
          onChange={(e) => setRange(e.target.value)}
        />
        <Input
          className="flex-1 min-w-[180px]"
          placeholder='Message template (use "{n}" for the number, or leave blank)'
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={appendNumbers}
            onChange={(e) => setAppendNumbers(e.target.checked)}
          />
          Append number
        </label>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!parsed}
          onClick={() => parsed && onApply(parsed.start, parsed.end, template, appendNumbers)}
        >
          Apply
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {label}. Example: <code>1-6</code> picks accounts #1..#6 and creates 6 rows. If the template contains <code>{"{n}"}</code> it is replaced with the account number; otherwise the number is appended (e.g. "Hi 1", "Hi 2", …).
        {parsed && ` — will create ${parsed.end - parsed.start + 1} row(s) (accounts #${parsed.start}..#${parsed.end}). Replaces current rows.`}
      </p>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/actions")({
  validateSearch: (s: Record<string, unknown>) =>
    z
      .object({
        tab: z.enum(["react", "forward", "vote", "broadcast", "comment", "reply", "edit", "deleteMessages"]).optional(),
      })
      .parse(s),
  component: () => (
    <AdminGate>
      <ActionsPage />
    </AdminGate>
  ),
});

type Tab = "react" | "forward" | "vote" | "broadcast" | "comment" | "reply" | "edit" | "deleteMessages";

type BroadcastRow = { id: string; message: string; targets: string; accountId?: string; files?: File[] };
type ReplyRow = { id: string; message: string; accountId?: string; files?: File[] };
type SendMode = "per-account" | "all-ids";
type TextFormat = "plain" | "mono" | "quote" | "html";

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

// The schedule picker shows "wall clock" time. Users in India expect that to
// mean IST (Asia/Kolkata) no matter what timezone their browser is set to,
// so we always interpret the datetime-local value as IST (+05:30) before
// converting to UTC for the server.
function istWallClockToDate(local: string): Date {
  const withSeconds = /T\d{2}:\d{2}:\d{2}/.test(local) ? local : `${local}:00`;
  return new Date(`${withSeconds}+05:30`);
}

const IST_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

function formatIst(d: Date): string {
  return `${IST_FORMATTER.format(d)} IST`;
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

function MultiAttachmentField({
  files,
  onChange,
  max = 10,
}: {
  files: File[];
  onChange: (f: File[]) => void;
  max?: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const previews = useMemo(() => {
    return files.map((f) => {
      const kind: "image" | "video" | "audio" | "other" = f.type.startsWith("image/")
        ? "image"
        : f.type.startsWith("video/")
          ? "video"
          : f.type.startsWith("audio/")
            ? "audio"
            : "other";
      const url = kind === "image" || kind === "video" ? URL.createObjectURL(f) : undefined;
      return { url, kind };
    });
  }, [files]);
  useEffect(() => {
    return () => {
      for (const p of previews) if (p.url) URL.revokeObjectURL(p.url);
    };
  }, [previews]);
  const addFiles = (list: FileList | null) => {
    if (!list || !list.length) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= max) break;
      next.push(f);
    }
    onChange(next);
    if (inputRef.current) inputRef.current.value = "";
  };
  const removeAt = (i: number) => onChange(files.filter((_, idx) => idx !== i));
  return (
    <div>
      <Label>Attachments (optional, up to {max})</Label>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => addFiles(e.target.files)}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        className={`mt-1 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed p-3 text-xs transition ${
          dragOver ? "border-primary bg-primary/5" : "border-border text-muted-foreground hover:bg-muted/40"
        }`}
      >
        <Paperclip className="h-4 w-4" />
        <span>Drag &amp; drop files here, or click to browse (max {max})</span>
      </div>
      {files.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="group relative overflow-hidden rounded-md border border-border bg-background">
              {previews[i]?.kind === "image" && previews[i]?.url ? (
                <img src={previews[i]!.url} alt={f.name} className="h-24 w-full object-cover" />
              ) : previews[i]?.kind === "video" && previews[i]?.url ? (
                <video src={previews[i]!.url} className="h-24 w-full object-cover" muted />
              ) : (
                <div className="flex h-24 flex-col items-center justify-center gap-1 p-2 text-xs text-muted-foreground">
                  <Paperclip className="h-5 w-5" />
                  <span className="truncate w-full text-center">{f.name}</span>
                </div>
              )}
              <button
                type="button"
                className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 shadow group-hover:opacity-100 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(i);
                }}
                aria-label="Remove attachment"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <div className="truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                {f.name} · {(f.size / 1024).toFixed(1)} KB
              </div>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {files.length > 1
            ? "Sent as a media album. Message text becomes the album caption."
            : "The message text above will be sent as the caption."}
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
  // Broadcast-replies panel state
  const [repliesRunId, setRepliesRunId] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>(search.tab ?? "react");
  const [showAccounts, setShowAccounts] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("actions-show-accounts") === "1";
  });
  const toggleAccounts = () => {
    setShowAccounts((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("actions-show-accounts", next ? "1" : "0");
      }
      return next;
    });
  };
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
  const [concurrency, setConcurrency] = useState<number>(() => {
    if (typeof window === "undefined") return 5;
    const v = Number(window.localStorage.getItem("tmpro:concurrency") || 5);
    return Number.isFinite(v) && v >= 1 && v <= 50 ? v : 5;
  });
  useEffect(() => {
    try { window.localStorage.setItem("tmpro:concurrency", String(concurrency)); } catch {}
  }, [concurrency]);
  const [rows, setRows] = useState<BroadcastRow[]>([
    { id: "broadcast-row-1", message: "", targets: "" },
  ]);
  const precheckFn = useServerFn(precheckBroadcastTargets);
  const [precheckByRow, setPrecheckByRow] = useState<Record<string, { loading: boolean; error?: string; data?: PrecheckResult[] }>>({});
  const [replyRows, setReplyRows] = useState<ReplyRow[]>([
    { id: "reply-row-1", message: "" },
  ]);
  const [broadcastMode, setBroadcastMode] = useState<SendMode>("per-account");
  const [replyMode, setReplyMode] = useState<SendMode>("per-account");
  const [broadcastSelectedIds, setBroadcastSelectedIds] = useState<string[]>([]);
  const [replySelectedIds, setReplySelectedIds] = useState<string[]>([]);
  const [actionSelectedIds, setActionSelectedIds] = useState<string[]>([]);
  const [textFormat, setTextFormat] = useState<TextFormat>("plain");
  const [showFormatExamples, setShowFormatExamples] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [deleteIds, setDeleteIds] = useState("");
  const [deleteMode, setDeleteMode] = useState<"list" | "range">("list");
  const [deleteRangeStart, setDeleteRangeStart] = useState("");
  const [deleteRangeEnd, setDeleteRangeEnd] = useState("");

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<{ ok: number; fail: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [scheduledAt, setScheduledAt] = useState<string>("");
  const [scheduling, setScheduling] = useState(false);
  const listSchedFn = useServerFn(listScheduledBroadcasts);
  const createSchedFn = useServerFn(createScheduledBroadcast);
  const cancelSchedFn = useServerFn(cancelScheduledBroadcast);
  const clearSchedHistoryFn = useServerFn(clearScheduledHistory);
  const reportSchedFn = useServerFn(getScheduleReport);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const reportQ = useQuery({
    queryKey: ["schedule-report", reportId],
    queryFn: () => reportSchedFn({ data: { id: reportId! } }),
    enabled: !!reportId && reportOpen,
    refetchInterval: reportOpen ? 3000 : false,
  });
  const schedulesQ = useQuery({
    queryKey: ["scheduled-broadcasts"],
    queryFn: () => listSchedFn(),
    refetchInterval: 15_000,
  });

  const uploadAttachment = async (file: File, isVoice = false) => {
    const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
    const path = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    const { error } = await supabase.storage
      .from("action-attachments")
      .upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) throw new Error(error.message);
    return { path, filename: file.name, mimeType: file.type || undefined, isVoice };
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
    let currentRunId: string | null = null;
    let currentKind: string | null = null;
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
        if (event === "start") {
          if (data.runId) currentRunId = String(data.runId);
          if (data.kind) currentKind = String(data.kind);
          addLog({ level: "info", message: `Run started: ${data.kind ?? "action"}` });
        }
        else if (event === "log") addLog({ accountId: data.accountId, level: data.level ?? "info", target: data.target, message: data.message ?? "" });
        else if (event === "done") addLog({ accountId: data.accountId, level: data.fail ? "warn" : "info", message: `Account done — ok ${data.ok}, fail ${data.fail}` });
        else if (event === "end") {
          setTotals({ ok: data.ok ?? 0, fail: data.fail ?? 0 });
          const message = `Finished — ok ${data.ok}, fail ${data.fail}`;
          if (data.fail) toast.warning(message);
          else toast.success(message);
          if (currentKind === "broadcast" && currentRunId && (data.ok ?? 0) > 0) {
            // Auto-open the replies panel for the just-completed broadcast.
            setRepliesRunId(currentRunId);
            qc.invalidateQueries({ queryKey: ["action-runs"] });
          }
        }
        else if (event === "aborted") addLog({ level: "warn", message: data.message ?? "Stopped" });
      }
    }
  };

  const run = async (mode: "apply" | "clear" = "apply") => {
    let src = parseMessageLink(source);
    if (tab === "deleteMessages" && deleteMode === "range") {
      const a = parseMessageLink(deleteRangeStart);
      const b = parseMessageLink(deleteRangeEnd);
      if (!a || !b) {
        toast.error("Enter valid start and end message links");
        return;
      }
      if (a.chat !== b.chat) {
        toast.error("Start and end links must be from the same chat");
        return;
      }
      src = a;
    }
    if (!src) {
      toast.error("Enter a valid message link (https://t.me/<chat>/<id>)");
      return;
    }
    if (allAccountIds.length === 0) {
      toast.error("No accounts available");
      return;
    }
    const runAccountIds =
      (tab === "react" || tab === "vote" || tab === "edit" || tab === "deleteMessages" || tab === "forward") && actionSelectedIds.length
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
    } else if (tab === "edit") {
      if (!editText.trim()) return toast.error("Enter replacement text");
      op = { kind: "edit", source: src, message: editText.trim(), format: textFormat };
    } else if (tab === "deleteMessages") {
      let messageIds: number[];
      if (deleteMode === "range") {
        const a = parseMessageLink(deleteRangeStart)!;
        const b = parseMessageLink(deleteRangeEnd)!;
        const lo = Math.min(a.msgId, b.msgId);
        const hi = Math.max(a.msgId, b.msgId);
        const span = hi - lo + 1;
        if (span > 2000) {
          toast.error(`Range too large (${span}). Max 2000 messages per run.`);
          return;
        }
        messageIds = Array.from({ length: span }, (_, i) => lo + i);
      } else {
        const ids = deleteIds
          .split(/[\s,]+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        messageIds = ids.length ? ids : [src.msgId];
      }
      op = { kind: "deleteMessages", chat: src.chat, messageIds, revoke: true };
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
          concurrency,
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
    let cleaned: { accountId: string; message: string; attachments?: { path: string; filename: string; mimeType?: string; isVoice?: boolean }[]; format?: TextFormat }[] = [];
    try {
      if (replyMode === "per-account") {
        const rows = replyRows.filter((r) => (r.accountId ?? "") && (r.message.trim() || (r.files?.length ?? 0) > 0));
        if (!rows.length) return toast.error("Pick an account and add message or file for each row");
        cleaned = await Promise.all(rows.map(async (r) => ({
          accountId: r.accountId!,
          message: r.message.trim(),
          attachments: r.files?.length
            ? await Promise.all(r.files.map((f) => uploadAttachment(f, voiceMode && r.files!.length === 1)))
            : undefined,
          format: textFormat,
        })));
      } else {
        const rows = replyRows.filter((r) => r.message.trim() || (r.files?.length ?? 0) > 0);
        if (!rows.length) return toast.error("Add at least one message or file");
        const uploads = await Promise.all(rows.map(async (r) => ({
          message: r.message.trim(),
          attachments: r.files?.length
            ? await Promise.all(r.files.map((f) => uploadAttachment(f, voiceMode && r.files!.length === 1)))
            : undefined,
          format: textFormat,
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
      concurrency,
      op: { kind: "reply", source: src, viaDiscussion: tab === "comment", rows: cleaned },
    });
  };

  const buildBroadcastCleaned = async (): Promise<
    { accountId: string; message: string; targets: string[]; attachments?: { path: string; filename: string; mimeType?: string; isVoice?: boolean }[]; format?: TextFormat }[] | null
  > => {
    const baseRows = rows
      .map((r) => ({
        accountId: r.accountId ?? "",
        message: r.message.trim(),
        targets: r.targets
          .split(/\r?\n|,/)
          .map((s) => s.trim())
          .filter(Boolean),
        files: r.files ?? [],
      }))
      .filter((r) => (r.message || r.files.length > 0) && r.targets.length);
    if (!baseRows.length) {
      toast.error("Add at least one row with message/files and targets");
      return null;
    }
    try {
      const uploaded = await Promise.all(
        baseRows.map(async (r) =>
          r.files.length
            ? await Promise.all(r.files.map((f) => uploadAttachment(f, voiceMode && r.files.length === 1)))
            : undefined,
        ),
      );
      const withAtt = baseRows.map((r, i) => ({
        accountId: r.accountId,
        message: r.message,
        targets: r.targets,
        attachments: uploaded[i],
        format: textFormat,
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
        withAtt.map((r) => ({ accountId, message: r.message, targets: r.targets, attachments: r.attachments, format: r.format })),
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
          concurrency,
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
    // datetime-local returns a wall-clock string with no timezone. Always
    // treat it as IST so scheduling works the same whether the user's
    // device is in India or elsewhere.
    const when = istWallClockToDate(scheduledAt);
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
          op: { kind: "broadcast", rows: cleaned },
          minDelay,
          maxDelay,
        },
      });
      toast.success(`Scheduled for ${formatIst(when)} (fires within ±1s)`);
      setScheduledAt("");
      await qc.invalidateQueries({ queryKey: ["scheduled-broadcasts"] });
      return res;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScheduling(false);
    }
  };

  const parseScheduledAt = () => {
    if (!scheduledAt) {
      toast.error("Pick a schedule time (with seconds)");
      return null;
    }
    const when = istWallClockToDate(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      toast.error("Invalid schedule time");
      return null;
    }
    if (when.getTime() < Date.now() + 5_000) {
      toast.error("Schedule at least 5 seconds in the future");
      return null;
    }
    return when;
  };

  const scheduleReply = async () => {
    const when = parseScheduledAt();
    if (!when) return;
    const src = parseMessageLink(source);
    if (!src) return toast.error("Enter a valid message link");
    if (allAccountIds.length === 0) return toast.error("No accounts available");
    let cleaned: { accountId: string; message: string; attachments?: { path: string; filename: string; mimeType?: string; isVoice?: boolean }[]; format?: TextFormat }[] = [];
    try {
      if (replyMode === "per-account") {
        const rs = replyRows.filter((r) => (r.accountId ?? "") && (r.message.trim() || (r.files?.length ?? 0) > 0));
        if (!rs.length) return toast.error("Pick an account and add message or file for each row");
        cleaned = await Promise.all(rs.map(async (r) => ({
          accountId: r.accountId!,
          message: r.message.trim(),
          attachments: r.files?.length
            ? await Promise.all(r.files.map((f) => uploadAttachment(f, voiceMode && r.files!.length === 1)))
            : undefined,
          format: textFormat,
        })));
      } else {
        const rs = replyRows.filter((r) => r.message.trim() || (r.files?.length ?? 0) > 0);
        if (!rs.length) return toast.error("Add at least one message or file");
        const uploads = await Promise.all(rs.map(async (r) => ({
          message: r.message.trim(),
          attachments: r.files?.length
            ? await Promise.all(r.files.map((f) => uploadAttachment(f, voiceMode && r.files!.length === 1)))
            : undefined,
          format: textFormat,
        })));
        const targetIds = replySelectedIds.length ? replySelectedIds : allAccountIds;
        if (!targetIds.length) return toast.error("Select at least one account");
        cleaned = targetIds.map((accountId, i) => ({ accountId, ...uploads[i % uploads.length] }));
      }
    } catch (e) {
      return toast.error((e as Error).message);
    }
    setScheduling(true);
    try {
      await createSchedFn({
        data: {
          scheduledAt: when.toISOString(),
          op: { kind: "reply", source: src, viaDiscussion: tab === "comment", rows: cleaned },
          minDelay,
          maxDelay,
        },
      });
      toast.success(`Scheduled for ${formatIst(when)} (fires within ±1s)`);
      setScheduledAt("");
      await qc.invalidateQueries({ queryKey: ["scheduled-broadcasts"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScheduling(false);
    }
  };

  const scheduleForward = async () => {
    const when = parseScheduledAt();
    if (!when) return;
    const src = parseMessageLink(source);
    if (!src) return toast.error("Enter a valid message link");
    const list = targets.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return toast.error("Enter at least one destination");
    const runAccountIds = actionSelectedIds.length ? actionSelectedIds : allAccountIds;
    if (!runAccountIds.length) return toast.error("No accounts available");
    setScheduling(true);
    try {
      await createSchedFn({
        data: {
          scheduledAt: when.toISOString(),
          op: { kind: "forward", source: src, accountIds: runAccountIds, targets: list },
          minDelay,
          maxDelay,
        },
      });
      toast.success(`Scheduled for ${formatIst(when)} (fires within ±1s)`);
      setScheduledAt("");
      await qc.invalidateQueries({ queryKey: ["scheduled-broadcasts"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScheduling(false);
    }
  };

  const scheduleEditOrDelete = async () => {
    const when = parseScheduledAt();
    if (!when) return;
    const src = parseMessageLink(source);
    if (!src) return toast.error("Enter a valid message link");
    const runAccountIds = actionSelectedIds.length ? actionSelectedIds : allAccountIds;
    if (!runAccountIds.length) return toast.error("No accounts available");
    let op: any;
    if (tab === "edit") {
      if (!editText.trim()) return toast.error("Enter replacement text");
      op = { kind: "edit", source: src, accountIds: runAccountIds, message: editText.trim(), format: textFormat };
    } else {
      const ids = deleteIds
        .split(/[\s,]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      op = { kind: "deleteMessages", chat: src.chat, accountIds: runAccountIds, messageIds: ids.length ? ids : [src.msgId], revoke: true };
    }
    setScheduling(true);
    try {
      await createSchedFn({ data: { scheduledAt: when.toISOString(), op, minDelay, maxDelay } });
      toast.success(`Scheduled for ${formatIst(when)} (continues automatically)`);
      setScheduledAt("");
      await qc.invalidateQueries({ queryKey: ["scheduled-broadcasts"] });
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
          <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
            <span className="text-muted-foreground">Parallel</span>
            <Input
              type="number"
              min={1}
              max={50}
              value={concurrency}
              onChange={(e) => {
                const v = Number(e.target.value);
                setConcurrency(Number.isFinite(v) ? Math.max(1, Math.min(50, v)) : 5);
              }}
              className="h-7 w-14"
            />
            <span className="text-muted-foreground">accts</span>
          </div>
          <Button variant="outline" size="sm" onClick={toggleAccounts}>
            {showAccounts ? (
              <>
                <EyeOff className="mr-1 h-3.5 w-3.5" /> Hide accounts
              </>
            ) : (
              <>
                <Eye className="mr-1 h-3.5 w-3.5" /> Show accounts ({accountList.length})
              </>
            )}
          </Button>
          <a href="/dashboard" className="text-sm text-muted-foreground underline">
            Back to dashboard
          </a>
        </div>
      </header>

      <div
        className={`mx-auto grid max-w-7xl gap-6 px-4 py-6 md:px-8 ${
          showAccounts ? "md:grid-cols-[280px_1fr]" : "md:grid-cols-1"
        }`}
      >
        {/* Accounts column */}
        {showAccounts && (
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
        )}

        {/* Main panel */}
        <section className="space-y-4">
          <div className="flex gap-2 border-b border-border">
            {(["react", "forward", "vote", "broadcast", "comment", "reply", "edit", "deleteMessages"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm capitalize ${
                  tab === t
                    ? "border-b-2 border-primary font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {t === "react" ? "Reactions" : t === "forward" ? "Forwarder" : t === "vote" ? "Poll voter" : t === "broadcast" ? "Broadcast" : t === "comment" ? "Comment" : t === "reply" ? "Reply" : t === "edit" ? "Scheduled edits" : "Bulk delete"}
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

            {(tab === "broadcast" || tab === "reply" || tab === "comment" || tab === "edit") && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm">
                <Label>Text format</Label>
                <button
                  type="button"
                  className={`rounded border px-2 py-1 text-xs ${textFormat === "plain" ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
                  onClick={() => setTextFormat("plain")}
                >
                  Plain
                </button>
                <button
                  type="button"
                  className={`rounded border px-2 py-1 font-mono text-xs ${textFormat === "mono" ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
                  onClick={() => setTextFormat("mono")}
                >
                  Monospace
                </button>
                <button
                  type="button"
                  className={`rounded border px-2 py-1 text-xs italic ${textFormat === "quote" ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
                  onClick={() => setTextFormat("quote")}
                >
                  Quote
                </button>
                <button
                  type="button"
                  className={`rounded border px-2 py-1 font-mono text-xs ${textFormat === "html" ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`}
                  onClick={() => setTextFormat("html")}
                  title="Use raw HTML tags in your message: <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strike</s>, <code>mono</code>, <pre>block</pre>, <blockquote>quote</blockquote>, <a href='url'>link</a>"
                >
                  HTML
                </button>
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-2 hover:underline"
                  onClick={() => setShowFormatExamples((v) => !v)}
                >
                  {showFormatExamples ? "Hide examples" : "Show examples"}
                </button>
                {(tab === "broadcast" || tab === "reply" || tab === "comment") && (
                  <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={voiceMode} onChange={(e) => setVoiceMode(e.target.checked)} />
                    Send attachments as voice notes
                  </label>
                )}
                {showFormatExamples && (
                  <div className="basis-full rounded-md border border-border bg-muted/30 p-3 text-xs">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-medium">Format examples</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setShowFormatExamples(false)}
                      >
                        Hide
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="font-medium text-foreground">Plain</div>
                        <div className="text-muted-foreground">Sends your text as-is.</div>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-background px-2 py-1">hello world</pre>
                      </div>
                      <div>
                        <div className="font-medium text-foreground">Monospace</div>
                        <div className="text-muted-foreground">Wraps the whole message in code style.</div>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-background px-2 py-1">hello world</pre>
                      </div>
                      <div>
                        <div className="font-medium text-foreground">Quote</div>
                        <div className="text-muted-foreground">Wraps the whole message in a blockquote.</div>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-background px-2 py-1">hello world</pre>
                      </div>
                      <div>
                        <div className="font-medium text-foreground">HTML (mix any tags in one message)</div>
                        <div className="text-muted-foreground">Type these tags directly in your message.</div>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-background px-2 py-1">{`<b>bold</b>
<i>italic</i>
<u>underline</u>
<s>strikethrough</s>
<code>mono</code>
<pre>code block</pre>
<blockquote>quote</blockquote>
<a href="https://example.com">link</a>`}</pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

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
                <AccountMultiPicker
                  accountList={accountList}
                  selectedIds={actionSelectedIds}
                  setSelectedIds={setActionSelectedIds}
                  allAccountIds={allAccountIds}
                />
                <div>
                  <div className="flex items-center justify-between">
                    <Label>Destinations</Label>
                    <TargetsPicker
                      accounts={accountList}
                      defaultAccountId={actionSelectedIds[0] || allAccountIds[0]}
                      onAdd={(picked) => {
                        const existing = targets
                          .split(/[\r\n,]+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        const merged = Array.from(new Set([...existing, ...picked]));
                        setTargets(merged.join("\n"));
                      }}
                    />
                  </div>
                  <Textarea
                    rows={5}
                    value={targets}
                    onChange={(e) => setTargets(e.target.value)}
                    placeholder="@mychannel&#10;@friend_username&#10;https://t.me/other"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Pick chats/groups/channels from the selected account above, or paste @username, t.me/… link, invite link, or numeric ID manually (one per line). Numeric IDs only work from accounts that have interacted with that user/chat before.
                  </p>
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

            {tab === "edit" && (
              <div className="space-y-3">
                <div>
                  <Label>Replacement text</Label>
                  <Textarea
                    rows={4}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    placeholder="New text for the selected message…"
                  />
                  <MessagePreview message={editText} format={textFormat} />
                </div>
                <DelayFields minDelay={minDelay} maxDelay={maxDelay} setMin={setMinDelay} setMax={setMaxDelay} />
                <AccountMultiPicker
                  accountList={accountList}
                  selectedIds={actionSelectedIds}
                  setSelectedIds={setActionSelectedIds}
                  allAccountIds={allAccountIds}
                />
              </div>
            )}

            {tab === "deleteMessages" && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={deleteMode === "list" ? "default" : "outline"}
                    onClick={() => setDeleteMode("list")}
                  >
                    IDs / single
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={deleteMode === "range" ? "default" : "outline"}
                    onClick={() => setDeleteMode("range")}
                  >
                    Link range
                  </Button>
                </div>
                {deleteMode === "list" ? (
                  <div>
                    <Label>Message IDs to delete</Label>
                    <Textarea
                      rows={3}
                      value={deleteIds}
                      onChange={(e) => setDeleteIds(e.target.value)}
                      placeholder="Leave empty to delete the linked message, or enter IDs: 1201, 1202, 1203"
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div>
                      <Label>Start message link</Label>
                      <Input
                        value={deleteRangeStart}
                        onChange={(e) => setDeleteRangeStart(e.target.value)}
                        placeholder="https://t.me/<chat>/1200"
                      />
                    </div>
                    <div>
                      <Label>End message link</Label>
                      <Input
                        value={deleteRangeEnd}
                        onChange={(e) => setDeleteRangeEnd(e.target.value)}
                        placeholder="https://t.me/<chat>/1350"
                      />
                    </div>
                    {(() => {
                      const a = parseMessageLink(deleteRangeStart);
                      const b = parseMessageLink(deleteRangeEnd);
                      if (!a || !b) return null;
                      if (a.chat !== b.chat)
                        return <p className="text-xs text-destructive">Both links must be from the same chat.</p>;
                      const span = Math.abs(b.msgId - a.msgId) + 1;
                      return (
                        <p className="text-xs text-muted-foreground">
                          Will delete {span} message{span === 1 ? "" : "s"} (IDs {Math.min(a.msgId, b.msgId)}–{Math.max(a.msgId, b.msgId)}).
                        </p>
                      );
                    })()}
                  </div>
                )}
                <DelayFields minDelay={minDelay} maxDelay={maxDelay} setMin={setMinDelay} setMax={setMaxDelay} />
                <AccountMultiPicker
                  accountList={accountList}
                  selectedIds={actionSelectedIds}
                  setSelectedIds={setActionSelectedIds}
                  allAccountIds={allAccountIds}
                />
              </div>
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
                {broadcastMode === "per-account" && (
                  <RangeApply
                    label="Auto-fill rows from account range"
                    accountsCount={accountList.length}
                    onApply={(start, end, template, appendNumbers) => {
                      const slice = accountList.slice(start - 1, end);
                      if (!slice.length) return;
                      const sharedTargets = rows[0]?.targets ?? "";
                      const sharedFiles = rows[0]?.files;
                      setRows(
                        slice.map((acc, i) => {
                          const n = start + i;
                          const msg = template.includes("{n}")
                            ? template.replaceAll("{n}", String(n))
                            : appendNumbers
                              ? `${template} ${n}`.trim()
                              : template;
                          return {
                            id: crypto.randomUUID(),
                            accountId: acc.id,
                            message: msg,
                            targets: sharedTargets,
                            files: sharedFiles,
                          };
                        }),
                      );
                    }}
                  />
                )}
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
                      {accountList.map((a, i) => {
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
                            <span className="truncate"><span className="text-muted-foreground mr-1">#{i + 1}</span>{a.first_name || a.username || a.phone}</span>
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
                          {accountList.map((a, i) => (
                            <option key={a.id} value={a.id}>
                              #{i + 1} — {a.first_name || a.username || a.phone}
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
                      <MessagePreview
                        message={row.message}
                        format={textFormat}
                        fileName={row.files?.length ? row.files.map((f) => f.name).join(", ") : null}
                        files={row.files ?? []}
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
                      <p className="text-xs text-muted-foreground mt-1">
                        Accepts @username, t.me/… link, invite link, or numeric ID (e.g. <code>123456789</code>). Numeric IDs need prior interaction from the sending account.
                      </p>
                      <div className="mt-2">
                        <TargetsPicker
                          accounts={accountList}
                          defaultAccountId={row.accountId || broadcastSelectedIds[0] || allAccountIds[0]}
                          onAdd={(picked) =>
                            setRows((rs) =>
                              rs.map((r) => {
                                if (r.id !== row.id) return r;
                                const existing = r.targets
                                  .split(/\r?\n/)
                                  .map((s) => s.trim())
                                  .filter(Boolean);
                                const merged = Array.from(new Set([...existing, ...picked]));
                                return { ...r, targets: merged.join("\n") };
                              }),
                            )
                          }
                        />
                      </div>
                    </div>
                    {(() => {
                      const pc = precheckByRow[row.id];
                      const runPrecheck = async () => {
                        const rowTargets = row.targets
                          .split(/\r?\n/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        if (!rowTargets.length) {
                          setPrecheckByRow((m) => ({ ...m, [row.id]: { loading: false, error: "No targets to check" } }));
                          return;
                        }
                        const accountIds =
                          broadcastMode === "per-account"
                            ? row.accountId
                              ? [row.accountId]
                              : []
                            : broadcastSelectedIds.length
                            ? broadcastSelectedIds
                            : allAccountIds;
                        if (!accountIds.length) {
                          setPrecheckByRow((m) => ({ ...m, [row.id]: { loading: false, error: "Pick at least one account first" } }));
                          return;
                        }
                        setPrecheckByRow((m) => ({ ...m, [row.id]: { loading: true } }));
                        try {
                          const res = await precheckFn({ data: { accountIds, targets: rowTargets, deep: true } });
                          setPrecheckByRow((m) => ({ ...m, [row.id]: { loading: false, data: res } }));
                        } catch (e: any) {
                          setPrecheckByRow((m) => ({ ...m, [row.id]: { loading: false, error: e?.message || "Precheck failed" } }));
                        }
                      };
                      return (
                        <div className="rounded-md border border-dashed border-border p-2 space-y-2">
                          <div className="flex items-center gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={runPrecheck} disabled={pc?.loading}>
                              {pc?.loading ? "Prechecking…" : "Precheck targets"}
                            </Button>
                            <p className="text-xs text-muted-foreground">
                              Verifies each ID resolves from the sending account(s) before broadcasting. Deep scan checks dialogs + visible group members.
                            </p>
                            {pc?.data && (
                              <button
                                type="button"
                                className="ml-auto text-xs underline text-muted-foreground"
                                onClick={() => setPrecheckByRow((m) => { const n = { ...m }; delete n[row.id]; return n; })}
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          {pc?.error && <p className="text-xs text-destructive">{pc.error}</p>}
                          {pc?.data && (
                            <div className="space-y-2 max-h-64 overflow-auto text-xs">
                              {pc.data.map((acc) => {
                                const ok = acc.results.filter((r) => r.ok).length;
                                const bad = acc.results.length - ok;
                                return (
                                  <div key={acc.accountId} className="rounded border border-border p-2">
                                    <div className="flex items-center gap-2 mb-1">
                                      <span className="font-medium truncate">{acc.accountLabel}</span>
                                      <span className="text-green-600">✓ {ok}</span>
                                      <span className="text-destructive">✗ {bad}</span>
                                      {bad > 0 && (
                                        <button
                                          type="button"
                                          className="ml-auto underline text-muted-foreground"
                                          onClick={() => {
                                            const keep = acc.results.filter((r) => r.ok).map((r) => r.target);
                                            setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, targets: keep.join("\n") } : r)));
                                          }}
                                        >
                                          Keep only reachable
                                        </button>
                                      )}
                                    </div>
                                    <ul className="space-y-0.5">
                                      {acc.results.map((r, i) => (
                                        <li key={i} className="flex items-start gap-2">
                                          <span className={r.ok ? "text-green-600" : "text-destructive"}>{r.ok ? "✓" : "✗"}</span>
                                          <span className="font-mono truncate max-w-[40%]">{r.target}</span>
                                          <span className="text-muted-foreground truncate">
                                            {r.ok ? r.kind : r.reason}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    <MultiAttachmentField
                      files={row.files ?? []}
                      onChange={(fs) =>
                        setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, files: fs } : r)))
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
                {replyMode === "per-account" && (
                  <RangeApply
                    label="Auto-fill rows from account range"
                    accountsCount={accountList.length}
                    onApply={(start, end, template, appendNumbers) => {
                      const slice = accountList.slice(start - 1, end);
                      if (!slice.length) return;
                      const sharedFiles = replyRows[0]?.files;
                      setReplyRows(
                        slice.map((acc, i) => {
                          const n = start + i;
                          const msg = template.includes("{n}")
                            ? template.replaceAll("{n}", String(n))
                            : appendNumbers
                              ? `${template} ${n}`.trim()
                              : template;
                          return {
                            id: crypto.randomUUID(),
                            accountId: acc.id,
                            message: msg,
                            files: sharedFiles,
                          };
                        }),
                      );
                    }}
                  />
                )}
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
                      {accountList.map((a, i) => {
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
                            <span className="truncate"><span className="text-muted-foreground mr-1">#{i + 1}</span>{a.first_name || a.username || a.phone}</span>
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
                          {accountList.map((a, i) => (
                            <option key={a.id} value={a.id}>
                              #{i + 1} — {a.first_name || a.username || a.phone}
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
                      <MessagePreview
                        message={row.message}
                        format={textFormat}
                        fileName={row.files?.length ? row.files.map((f) => f.name).join(", ") : null}
                        files={row.files ?? []}
                      />
                    </div>
                    <MultiAttachmentField
                      files={row.files ?? []}
                      onChange={(fs) =>
                        setReplyRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, files: fs } : r)))
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
                <>
                  <Button onClick={runBroadcast} disabled={running || scheduling}>
                    <Play className="mr-1 h-4 w-4" /> Run broadcast ({rows.length} row{rows.length === 1 ? "" : "s"})
                  </Button>
                </>
              ) : (tab === "reply" || tab === "comment") ? (
                <Button onClick={runReply} disabled={running || scheduling}>
                  <Play className="mr-1 h-4 w-4" /> Send {replyRows.length} {tab}{replyRows.length === 1 ? "" : "s"}
                </Button>
              ) : (
                <Button
                  onClick={() => run("apply")}
                  disabled={
                    running ||
                    scheduling ||
                    allAccountIds.length === 0 ||
                    (tab === "vote" && !!pollInfo?.closed)
                  }
                >
                  <Play className="mr-1 h-4 w-4" />
                  {tab === "react" ? "React" : tab === "vote" ? "Vote" : tab === "edit" ? "Edit" : tab === "deleteMessages" ? "Delete" : "Run"} on {allAccountIds.length} account{allAccountIds.length === 1 ? "" : "s"}
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
              {(tab === "broadcast" || tab === "reply" || tab === "comment" || tab === "forward" || tab === "edit" || tab === "deleteMessages") && (
                <>
                  <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <input
                      type="datetime-local"
                      step={1}
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                      className="bg-transparent text-sm outline-none"
                      title="Schedule time (with seconds — accurate to ±1s)"
                    />
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">IST</span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={
                      tab === "broadcast"
                        ? scheduleBroadcast
                        : tab === "forward"
                          ? scheduleForward
                          : tab === "edit" || tab === "deleteMessages"
                            ? scheduleEditOrDelete
                            : scheduleReply
                    }
                    disabled={scheduling || running || !scheduledAt}
                  >
                    <CalendarClock className="mr-1 h-4 w-4" />
                    {scheduling ? "Scheduling…" : "Schedule"}
                  </Button>
                </>
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

          {(tab === "broadcast" || tab === "reply" || tab === "comment" || tab === "forward" || tab === "edit" || tab === "deleteMessages") && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-muted-foreground" />
                <div className="text-sm font-medium">Scheduled actions</div>
                <span className="ml-auto text-xs text-muted-foreground">
                  {schedulesQ.data?.length ?? 0} total · fires within ±1s of the target second
                </span>
                <button
                  type="button"
                  className="text-xs text-destructive underline disabled:opacity-40 disabled:no-underline"
                  disabled={!(schedulesQ.data ?? []).some((s) => s.status !== "pending" && s.status !== "running")}
                  onClick={async () => {
                    if (!confirm("Clear finished/cancelled/failed schedules? Pending and running are kept.")) return;
                    try {
                      const res = await clearSchedHistoryFn();
                      toast.success(`Cleared ${res.deleted} schedule${res.deleted === 1 ? "" : "s"}`);
                      await qc.invalidateQueries({ queryKey: ["scheduled-broadcasts"] });
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  }}
                >
                  Clear history
                </button>
              </div>
              {(schedulesQ.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No schedules yet.</p>
              ) : (
                <div className="max-h-64 space-y-1 overflow-auto text-sm">
                  {(schedulesQ.data ?? []).map((s) => {
                    const when = new Date(s.scheduledAt);
                    const statusColor =
                      s.status === "pending"
                        ? "text-primary"
                        : s.status === "running"
                        ? "text-yellow-500"
                        : s.status === "done"
                        ? "text-emerald-500"
                        : s.status === "cancelled"
                        ? "text-muted-foreground"
                        : "text-destructive";
                    return (
                      <div
                        key={s.id}
                        className="flex flex-wrap items-center gap-2 rounded border border-border/50 px-2 py-1.5"
                      >
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">
                          {formatIst(when)}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                          {s.kind}
                        </span>
                        <span className={`text-xs uppercase tracking-wide ${statusColor}`}>{s.status}</span>
                        <span className="text-xs text-muted-foreground">· {s.summary}</span>
                        {s.totalItems ? (
                          <span className="text-xs text-muted-foreground">
                            · {s.processedItems}/{s.totalItems}
                          </span>
                        ) : null}
                        {s.error && (
                          <span className="text-xs text-destructive truncate max-w-[40ch]" title={s.error}>
                            {s.error}
                          </span>
                        )}
                        <button
                          type="button"
                          className="ml-auto text-xs text-primary underline"
                          onClick={() => {
                            setReportId(s.id);
                            setReportOpen(true);
                          }}
                        >
                          Report
                        </button>
                        {s.status === "pending" && (
                          <button
                            type="button"
                            className="text-xs text-destructive underline"
                            onClick={async () => {
                              try {
                                await cancelSchedFn({ data: { id: s.id } });
                                toast.success("Cancelled");
                                await qc.invalidateQueries({ queryKey: ["scheduled-broadcasts"] });
                              } catch (e) {
                                toast.error((e as Error).message);
                              }
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <Dialog open={reportOpen} onOpenChange={(o) => { setReportOpen(o); if (!o) setReportId(null); }}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Broadcast timing report (IST)</DialogTitle>
              </DialogHeader>
              {reportQ.isLoading || !reportQ.data ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <div className="space-y-3">
                  <div className="rounded border border-border p-3 text-xs space-y-1">
                    <div>
                      <span className="text-muted-foreground">Scheduled: </span>
                      <span className="font-mono">{formatIst(new Date(reportQ.data.schedule.scheduledAt))}</span>
                    </div>
                    {reportQ.data.schedule.dispatchedAt && (
                      <div>
                        <span className="text-muted-foreground">Dispatched (cron picked up): </span>
                        <span className="font-mono">{formatIst(new Date(reportQ.data.schedule.dispatchedAt))}</span>
                        <span className="ml-2 text-muted-foreground">
                          ({(new Date(reportQ.data.schedule.dispatchedAt).getTime() - new Date(reportQ.data.schedule.scheduledAt).getTime()) / 1000}s)
                        </span>
                      </div>
                    )}
                    {reportQ.data.schedule.completedAt && (
                      <div>
                        <span className="text-muted-foreground">Completed: </span>
                        <span className="font-mono">{formatIst(new Date(reportQ.data.schedule.completedAt))}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">Status: </span>
                      <span className="uppercase tracking-wide">{reportQ.data.schedule.status}</span>
                    </div>
                  </div>
                  <div className="max-h-[420px] overflow-auto rounded border border-border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted">
                        <tr className="text-left">
                          <th className="px-2 py-1.5">Account</th>
                          <th className="px-2 py-1.5">Target</th>
                          <th className="px-2 py-1.5">Scheduled (IST)</th>
                          <th className="px-2 py-1.5">Sent (IST)</th>
                          <th className="px-2 py-1.5">Δ</th>
                          <th className="px-2 py-1.5">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportQ.data.items.map((it) => (
                          <tr key={it.id} className="border-t border-border/50 align-top">
                            <td className="px-2 py-1.5">
                              <div className="font-medium">{it.accountLabel}</div>
                              {it.accountPhone && <div className="text-muted-foreground">{it.accountPhone}</div>}
                            </td>
                            <td className="px-2 py-1.5 max-w-[20ch]">
                              {it.target ? (
                                <ChatIdChip id={it.target} accountId={it.accountId} />
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="px-2 py-1.5 font-mono">{formatIst(new Date(it.scheduledFor))}</td>
                            <td className="px-2 py-1.5 font-mono">
                              {it.processedAt ? formatIst(new Date(it.processedAt)) : "—"}
                            </td>
                            <td className="px-2 py-1.5 font-mono">
                              {it.deltaMs === null ? "—" : `${(it.deltaMs / 1000).toFixed(2)}s`}
                            </td>
                            <td className="px-2 py-1.5">
                              <span
                                className={
                                  it.status === "done"
                                    ? "text-emerald-500"
                                    : it.status === "failed"
                                    ? "text-destructive"
                                    : it.status === "processing"
                                    ? "text-yellow-500"
                                    : "text-muted-foreground"
                                }
                              >
                                {it.status}
                              </span>
                              {it.error && (
                                <div className="text-destructive text-[10px] mt-0.5 max-w-[30ch]" title={it.error}>
                                  {it.error}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const rows = reportQ.data!.items.map((it) =>
                          [
                            it.accountLabel,
                            it.accountPhone ?? "",
                            it.target ?? "",
                            formatIst(new Date(it.scheduledFor)),
                            it.processedAt ? formatIst(new Date(it.processedAt)) : "",
                            it.deltaMs === null ? "" : `${(it.deltaMs / 1000).toFixed(2)}s`,
                            it.status,
                            (it.error ?? "").replace(/\s+/g, " "),
                          ].join("\t"),
                        );
                        const header = ["Account", "Phone", "Target", "Scheduled (IST)", "Sent (IST)", "Delta", "Status", "Error"].join("\t");
                        void navigator.clipboard.writeText([header, ...rows].join("\n"));
                        toast.success("Report copied");
                      }}
                    >
                      <Copy className="mr-2 h-3.5 w-3.5" /> Copy report
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>

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
            onViewReplies={(runId) => setRepliesRunId(runId)}
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

      {repliesRunId && (
        <BroadcastRepliesDialog
          runId={repliesRunId}
          onClose={() => setRepliesRunId(null)}
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
  onViewReplies,
}: {
  runs: any[];
  accountList: Account[];
  loading: boolean;
  onRerun: (params: any) => void;
  onEdit: (run: any) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onClearAll: () => void;
  onViewReplies: (runId: string) => void;
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
      {loading && <Loader size="sm" />}
      {!loading && runs.length === 0 && (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      )}
      <div className="space-y-2">
        {runs.map((r) => {
          const t = r.totals ?? {};
          const ok = t.ok ?? 0;
          const fail = t.fail ?? 0;
          const isBroadcast = r.kind === "broadcast";
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
                {isBroadcast && (
                  <Button size="sm" variant="outline" onClick={() => onViewReplies(r.id)}>
                    <MessageSquareReply className="mr-1 h-3.5 w-3.5" /> View replies
                  </Button>
                )}
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
                    <div className="mt-2">
                      <TargetsPicker
                        accounts={accountList}
                        defaultAccountId={row.accountId || undefined}
                        onAdd={(picked) =>
                          setBRows((rs) =>
                            rs.map((r) => {
                              if (r.id !== row.id) return r;
                              const existing = r.targets
                                .split(/\r?\n/)
                                .map((s) => s.trim())
                                .filter(Boolean);
                              const merged = Array.from(new Set([...existing, ...picked]));
                              return { ...r, targets: merged.join("\n") };
                            }),
                          )
                        }
                      />
                    </div>
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

// ─────────────────────────────────────────────────────────────────────────
// Broadcast Replies viewer
// ─────────────────────────────────────────────────────────────────────────

type ReplyButton =
  | { kind: "callback"; text: string; data: string; requiresPassword?: boolean }
  | { kind: "url"; text: string; url: string }
  | { kind: "urlAuth"; text: string; url: string; buttonId?: number }
  | { kind: "switchInline"; text: string; query: string; samePeer: boolean }
  | { kind: "webview"; text: string; url?: string }
  | { kind: "game"; text: string }
  | { kind: "buy"; text: string }
  | { kind: "other"; text: string; className: string };

type ReplyMsg = {
  id: number;
  date: number;
  senderId: string | null;
  text: string;
  mediaKind: string | null;
  replyMarkup: ReplyButton[][] | null;
};

type ReplyPair = {
  accountId: string;
  accountName: string;
  target: string;
  messages: ReplyMsg[];
  error: string | null;
};

function BroadcastRepliesDialog({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const fetchReplies = useServerFn(getBroadcastReplies);
  const refresh = useServerFn(refreshReplyThread);
  const press = useServerFn(pressInlineButton);

  const [loading, setLoading] = useState(true);
  const [pairs, setPairs] = useState<ReplyPair[]>([]);
  const [runCreatedAt, setRunCreatedAt] = useState<number>(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // key of button being clicked
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  // Per-pair bot response log + show/hide state
  const [botLogs, setBotLogs] = useState<
    Record<string, { time: number; text: string; alert: boolean }[]>
  >({});
  const [logsOpen, setLogsOpen] = useState<Record<string, boolean>>({});

  const mergeFresh = (
    prev: ReplyPair[],
    accountId: string,
    target: string,
    fresh: ReplyMsg[],
  ) =>
    prev.map((row) => {
      if (row.accountId !== accountId || row.target !== target) return row;
      const byId = new Map<number, ReplyMsg>();
      for (const m of row.messages) byId.set(m.id, m);
      for (const m of fresh) byId.set(m.id, m); // fresh overrides existing (edits/new buttons)
      return {
        ...row,
        messages: [...byId.values()].sort((a, b) => a.id - b.id),
      };
    });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchReplies({ data: { runId } });
      setPairs(res.pairs as ReplyPair[]);
      setRunCreatedAt(res.runCreatedAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Per-card auto-refresh — pulls single pair every 6s if the tab is visible.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      // Refresh each pair sequentially to avoid opening many connections at once.
      for (const p of pairs) {
        try {
          const res = await refresh({
            data: {
              accountId: p.accountId,
              target: p.target,
              sinceMs: runCreatedAt - 5000,
              // sinceMsgId=0 → re-fetch latest 12 so edits + new inline buttons
              // on existing messages get picked up.
              sinceMsgId: 0,
            },
          });
          const fresh = res.messages as ReplyMsg[];
          if (fresh.length) {
            setPairs((prev) => mergeFresh(prev, p.accountId, p.target, fresh));
          }
        } catch {
          /* ignore transient refresh errors */
        }
      }
    }, 6000);
    return () => window.clearInterval(id);
  }, [autoRefresh, pairs, runCreatedAt, refresh]);

  const onPress = async (pair: ReplyPair, msgId: number, btn: ReplyButton, key: string) => {
    if (btn.kind === "url" || btn.kind === "urlAuth" || btn.kind === "webview") {
      const url = (btn as any).url as string | undefined;
      if (!url) {
        toast.error("Button has no URL");
        return;
      }
      setConfirmUrl(url);
      return;
    }
    if (btn.kind !== "callback") {
      toast.info("This button type isn't supported from a user account");
      return;
    }
    setBusy(key);
    const pairKey = `${pair.accountId}:${pair.target}`;
    try {
      const res = await press({
        data: {
          accountId: pair.accountId,
          target: pair.target,
          msgId,
          data: btn.data,
        },
      });
      if (res.message) {
        // Log to per-pair Bot responses section and reveal it.
        setBotLogs((prev) => ({
          ...prev,
          [pairKey]: [
            ...(prev[pairKey] ?? []),
            { time: Date.now(), text: res.message, alert: !!res.alert },
          ],
        }));
        setLogsOpen((prev) => ({ ...prev, [pairKey]: true }));
      } else if (res.url) {
        setConfirmUrl(res.url);
      } else {
        setBotLogs((prev) => ({
          ...prev,
          [pairKey]: [
            ...(prev[pairKey] ?? []),
            { time: Date.now(), text: "(no response)", alert: false },
          ],
        }));
        setLogsOpen((prev) => ({ ...prev, [pairKey]: true }));
      }
      // Pull fresh messages for this pair immediately (re-fetch latest to catch edits).
      const rf = await refresh({
        data: {
          accountId: pair.accountId,
          target: pair.target,
          sinceMs: runCreatedAt - 5000,
          sinceMsgId: 0,
        },
      });
      const fresh = rf.messages as ReplyMsg[];
      if (fresh.length) {
        setPairs((prev) => mergeFresh(prev, pair.accountId, pair.target, fresh));
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquareReply className="h-4 w-4" />
              Broadcast replies
            </DialogTitle>
          </DialogHeader>
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Since {new Date(runCreatedAt).toLocaleString()}
            </span>
            <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh
            </label>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RotateCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh all
            </Button>
          </div>

          {loading && pairs.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading replies…
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && pairs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              This run has no account/target pairs.
            </p>
          )}

          <div className="max-h-[65vh] space-y-3 overflow-auto pr-1">
            {pairs.map((p) => (
              <div
                key={`${p.accountId}:${p.target}`}
                className="rounded-md border border-border bg-card p-3"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">{p.accountName}</span>
                  <span className="text-xs text-muted-foreground">→</span>
                  <ChatIdChip id={p.target} accountId={p.accountId} />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {p.messages.length} reply{p.messages.length === 1 ? "" : "ies"}
                  </span>
                  {(botLogs[`${p.accountId}:${p.target}`]?.length ?? 0) > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() =>
                        setLogsOpen((prev) => ({
                          ...prev,
                          [`${p.accountId}:${p.target}`]: !prev[`${p.accountId}:${p.target}`],
                        }))
                      }
                    >
                      {logsOpen[`${p.accountId}:${p.target}`] ? "Hide" : "Show"} bot responses (
                      {botLogs[`${p.accountId}:${p.target}`]?.length ?? 0})
                    </Button>
                  )}
                </div>
                {logsOpen[`${p.accountId}:${p.target}`] &&
                  (botLogs[`${p.accountId}:${p.target}`]?.length ?? 0) > 0 && (
                    <div className="mb-2 rounded-md border border-dashed border-primary/30 bg-primary/5 p-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Bot responses
                        </span>
                        <button
                          className="text-[10px] text-muted-foreground hover:underline"
                          onClick={() =>
                            setBotLogs((prev) => ({
                              ...prev,
                              [`${p.accountId}:${p.target}`]: [],
                            }))
                          }
                        >
                          Clear
                        </button>
                      </div>
                      <div className="space-y-1">
                        {botLogs[`${p.accountId}:${p.target}`].map((l, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <span className="mt-0.5 text-[10px] text-muted-foreground">
                              {new Date(l.time).toLocaleTimeString()}
                            </span>
                            <span className={l.alert ? "text-amber-600" : ""}>{l.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                {p.error && (
                  <p className="mb-2 text-xs text-destructive">
                    <AlertTriangle className="mr-1 inline h-3 w-3" />
                    {p.error}
                  </p>
                )}
                {p.messages.length === 0 && !p.error && (
                  <p className="text-xs text-muted-foreground">
                    No replies yet — the chat hasn't answered.
                  </p>
                )}
                <div className="space-y-2">
                  {p.messages.map((m) => (
                    <div key={m.id} className="rounded-md bg-muted/40 p-2">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                        #{m.id} · {new Date(m.date).toLocaleTimeString()}
                        {m.mediaKind ? ` · ${m.mediaKind}` : ""}
                      </div>
                      {m.text && (
                        <div className="whitespace-pre-wrap break-words text-sm">
                          {m.text}
                        </div>
                      )}
                      {!m.text && !m.mediaKind && (
                        <div className="text-xs italic text-muted-foreground">
                          (empty message)
                        </div>
                      )}
                      {m.replyMarkup && (
                        <div className="mt-2 space-y-1">
                          {m.replyMarkup.map((row, ri) => (
                            <div key={ri} className="flex flex-wrap gap-1">
                              {row.map((btn, ci) => {
                                const key = `${p.accountId}:${p.target}:${m.id}:${ri}:${ci}`;
                                const isBusy = busy === key;
                                const clickable =
                                  btn.kind === "callback" ||
                                  btn.kind === "url" ||
                                  btn.kind === "urlAuth" ||
                                  btn.kind === "webview";
                                const title =
                                  btn.kind === "callback"
                                    ? "Callback button"
                                    : btn.kind === "url" || btn.kind === "urlAuth"
                                      ? `Opens: ${(btn as any).url}`
                                      : btn.kind === "webview"
                                        ? "Opens a Telegram WebApp (limited support)"
                                        : btn.kind === "switchInline"
                                          ? "Switch-inline button (not supported)"
                                          : `${btn.kind} button (not supported)`;
                                return (
                                  <button
                                    key={ci}
                                    type="button"
                                    title={title}
                                    disabled={!clickable || isBusy}
                                    onClick={() => onPress(p, m.id, btn, key)}
                                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                                      clickable
                                        ? "border-primary/40 bg-primary/10 text-foreground hover:bg-primary/20"
                                        : "cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60"
                                    }`}
                                  >
                                    {isBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                                    {btn.kind === "url" || btn.kind === "urlAuth" ? (
                                      <ExternalLink className="h-3 w-3" />
                                    ) : null}
                                    <span className="truncate max-w-[16rem]">{btn.text}</span>
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {confirmUrl && (
        <Dialog open onOpenChange={(o) => !o && setConfirmUrl(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Open external link?</DialogTitle>
            </DialogHeader>
            <p className="break-all rounded-md border border-border bg-muted p-2 text-xs">
              {confirmUrl}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmUrl(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  window.open(confirmUrl, "_blank", "noopener,noreferrer");
                  setConfirmUrl(null);
                }}
              >
                <ExternalLink className="mr-1 h-4 w-4" /> Open
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}