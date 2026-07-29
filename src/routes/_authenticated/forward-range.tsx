import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { listDialogs } from "@/lib/tg-viewer.functions";
import { forwardMessageRange } from "@/lib/forward-range.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Forward, ArrowRight } from "lucide-react";
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

function ForwardRangePage() {
  const listAccountsFn = useServerFn(listAccounts);
  const listDialogsFn = useServerFn(listDialogs);
  const forwardFn = useServerFn(forwardMessageRange);

  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAccountsFn() });
  const accounts = accountsQ.data ?? [];

  const [accountId, setAccountId] = useState<string>("");
  const [sourcePeerKey, setSourcePeerKey] = useState<string>("");
  const [targetPeerKey, setTargetPeerKey] = useState<string>("");
  const [fromMsgId, setFromMsgId] = useState<string>("");
  const [toMsgId, setToMsgId] = useState<string>("");
  const [dropAuthor, setDropAuthor] = useState(false);
  const [markRead, setMarkRead] = useState(true);
  const [delayMs, setDelayMs] = useState<string>("300");
  const [logs, setLogs] = useState<Array<{ level: string; message: string }>>([]);

  const dialogsQ = useQuery({
    queryKey: ["forward-range-dialogs", accountId],
    queryFn: () => listDialogsFn({ data: { accountId, limit: 2000, withPhotos: true } }),
    enabled: !!accountId,
  });
  const dialogs: Dialog[] = (dialogsQ.data?.dialogs ?? []) as Dialog[];

  const runMut = useMutation({
    mutationFn: async () => {
      const fromN = Number(fromMsgId);
      const toN = Number(toMsgId);
      if (!accountId) throw new Error("Pick an account.");
      if (!sourcePeerKey) throw new Error("Pick a source chat.");
      if (!targetPeerKey) throw new Error("Pick a target chat.");
      if (sourcePeerKey === targetPeerKey) throw new Error("Source and target must differ.");
      if (!Number.isFinite(fromN) || !Number.isFinite(toN) || fromN < 1 || toN < 1)
        throw new Error("Enter valid message IDs (from / to).");
      setLogs([{ level: "info", message: "Starting…" }]);
      const res = await forwardFn({
        data: {
          accountId,
          sourcePeerKey,
          targetPeerKey,
          fromMsgId: fromN,
          toMsgId: toN,
          dropAuthor,
          markRead,
          delayMs: Math.max(0, Math.min(60000, Number(delayMs) || 0)),
        },
      });
      return res;
    },
    onSuccess: (res) => {
      setLogs(res.logs);
      toast.success(`Forwarded ${res.ok} · Failed ${res.fail} · Missing ${res.missing}`);
    },
    onError: (e: any) => {
      const msg = e?.message ?? String(e);
      setLogs((prev) => [...prev, { level: "error", message: msg }]);
      toast.error(msg);
    },
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !runMut.isPending) {
      e.preventDefault();
      runMut.mutate();
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
            <CardTitle className="text-base">3. Target chat</CardTitle>
          </CardHeader>
          <CardContent>
            {!accountId && <div className="text-sm text-muted-foreground">Pick an account first.</div>}
            {accountId && (
              <ChatPicker
                label="To (destination)"
                dialogs={dialogs}
                value={targetPeerKey}
                onChange={setTargetPeerKey}
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
          <Button
            className="w-full"
            onClick={() => runMut.mutate()}
            disabled={runMut.isPending || !accountId || !sourcePeerKey || !targetPeerKey || !fromMsgId || !toMsgId}
          >
            {runMut.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Forwarding…</> : <><Forward className="h-4 w-4 mr-2" /> Forward messages (Enter)</>}
          </Button>
        </CardContent>
      </Card>

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
                  [{l.level}] {l.message}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}