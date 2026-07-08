import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import {
  createProofTask,
  listProofTasks,
  listProofRuns,
  runProofTask,
} from "@/lib/proof.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { AdminGate } from "@/components/AdminGate";
import { Camera, Play, RefreshCw } from "lucide-react";
import {
  buildChannelViewSvg,
  buildChatListSvg,
  SAMPLE_OTHERS,
} from "@/lib/proof-render";

function ProofPreview({
  format,
  channelLink,
}: {
  format: "auto" | "chat_list" | "channel_view";
  channelLink: string;
}) {
  const svg = useMemo(() => {
    const cleaned = (channelLink || "")
      .trim()
      .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
      .replace(/^@/, "")
      .replace(/^\+/, "")
      .replace(/[?#].*$/, "")
      .replace(/^joinchat\//i, "");
    const title =
      cleaned
        .split(/[-_.\s/]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ") || "Sample Channel";
    const info = { title, username: cleaned || null, subscribers: 12_500 };
    const isPrivateLike = /^[+]|^joinchat\//i.test(channelLink.trim());
    const effective =
      format === "auto" ? (isPrivateLike ? "chat_list" : "channel_view") : format;
    return effective === "chat_list"
      ? buildChatListSvg(info, SAMPLE_OTHERS)
      : buildChannelViewSvg(info);
  }, [format, channelLink]);

  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  const label =
    format === "auto"
      ? "Auto — preview shows chat list for private links, channel view otherwise"
      : format === "chat_list"
        ? "Chat list style"
        : "Channel view style";

  return (
    <section className="rounded-lg border border-border bg-card p-4 md:p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Live preview</h2>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="flex justify-center rounded-md bg-[#0a1826] p-4">
        <img
          src={dataUrl}
          alt="Screenshot preview"
          className="max-h-[480px] w-auto rounded-md shadow-lg"
        />
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Preview uses sample data. Real screenshot uses the actual channel title, subscribers, and (for chat list) the account's recent chats.
      </p>
    </section>
  );
}

export const Route = createFileRoute("/_authenticated/proof")({
  component: () => (
    <AdminGate>
      <ProofPage />
    </AdminGate>
  ),
});

function ProofPage() {
  const qc = useQueryClient();
  const listAcc = useServerFn(listAccounts);
  const create = useServerFn(createProofTask);
  const listT = useServerFn(listProofTasks);
  const run = useServerFn(runProofTask);

  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const tasksQ = useQuery({ queryKey: ["proof-tasks"], queryFn: () => listT() });
  const accounts = accountsQ.data ?? [];
  const tasks = tasksQ.data ?? [];

  const [channelLink, setChannelLink] = useState("");
  const [target, setTarget] = useState("");
  const [caption, setCaption] = useState("");
  const [format, setFormat] = useState<"auto" | "chat_list" | "channel_view">("auto");
  const [parallel, setParallel] = useState<number>(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelectedIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allSelected = accounts.length > 0 && selectedIds.length === accounts.length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelLink.trim()) return toast.error("Channel link required");
    if (!target.trim()) return toast.error("Target required");
    if (!selectedIds.length) return toast.error("Pick at least one account");
    setBusy(true);
    try {
      const { taskId } = await create({
        data: {
          channelLink: channelLink.trim(),
          target: target.trim(),
          caption: caption.trim() || null,
          format,
          parallel: Math.max(1, Math.min(20, Math.trunc(parallel) || 1)),
          accountIds: selectedIds,
        },
      });
      toast.success("Task created — running…");
      await qc.invalidateQueries({ queryKey: ["proof-tasks"] });
      setOpenTask(taskId);
      const res = await run({ data: { taskId } });
      toast.success(`Sent ${res.ran}/${selectedIds.length} screenshots`);
      await qc.invalidateQueries({ queryKey: ["proof-runs", taskId] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-8 md:px-8">
        <div className="mb-6 flex items-center gap-3">
          <Camera className="h-6 w-6 text-[#5eb0ef]" />
          <h1 className="text-2xl font-semibold tracking-tight">Join & Screenshot Proof</h1>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          Paste a channel link, pick accounts, and choose a screenshot format. Each
          account joins the channel and sends a proof screenshot to your target.
        </p>

        <form onSubmit={submit} className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-4 md:p-6">
            <h2 className="mb-4 text-lg font-semibold">Task</h2>
            <div className="space-y-4">
              <div>
                <Label>Channel link</Label>
                <Input
                  placeholder="@channel, t.me/channel, or t.me/+inviteHash"
                  value={channelLink}
                  onChange={(e) => setChannelLink(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label>Send screenshot to (target)</Label>
                <Input
                  placeholder="@username, t.me/yourreports"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label>Caption (optional)</Label>
                <Textarea
                  rows={2}
                  placeholder="You joined this channel · {title}"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                />
              </div>
              <div>
                <Label>Screenshot format</Label>
                <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (private → chat list, public → channel view)</SelectItem>
                    <SelectItem value="chat_list">Chat list (private-style, image 1)</SelectItem>
                    <SelectItem value="channel_view">Channel view (public-style, image 2)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Parallel accounts</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={parallel}
                  onChange={(e) => setParallel(Number(e.target.value) || 1)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  How many accounts run at the same time (1–20). Higher = faster, more Telegram rate-limit risk.
                </p>
              </div>
            </div>
          </section>

          <ProofPreview format={format} channelLink={channelLink} />

          <section className="rounded-lg border border-border bg-card p-4 md:p-6">
            <h2 className="mb-4 text-lg font-semibold">Accounts</h2>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {selectedIds.length} / {accounts.length} accounts selected
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={allSelected ? "outline" : "default"}
                  size="sm"
                  onClick={() => setSelectedIds(accounts.map((a) => a.id))}
                  disabled={allSelected}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds([])}
                  disabled={!selectedIds.length}
                >
                  Deselect all
                </Button>
              </div>
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {accounts.map((a) => (
                <label
                  key={a.id}
                  className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2.5 hover:bg-accent"
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={selectedIds.includes(a.id)}
                      onCheckedChange={() => toggle(a.id)}
                    />
                    <span className="text-sm font-medium">
                      {a.first_name || a.username || a.phone}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">{a.phone}</span>
                </label>
              ))}
              {!accounts.length && (
                <p className="text-sm text-muted-foreground">No accounts available.</p>
              )}
            </div>
          </section>

          <Button type="submit" disabled={busy || !selectedIds.length} className="w-full" size="lg">
            {busy ? "Running…" : `Join & send proof on ${selectedIds.length || 0} account${selectedIds.length === 1 ? "" : "s"}`}
          </Button>
        </form>

        <section className="mt-10">
          <h2 className="mb-3 text-lg font-semibold">Recent tasks</h2>
          <div className="space-y-2">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                open={openTask === t.id}
                onOpen={() => setOpenTask(openTask === t.id ? null : t.id)}
              />
            ))}
            {!tasks.length && (
              <p className="text-sm text-muted-foreground">No tasks yet.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function TaskRow({
  task,
  open,
  onOpen,
}: {
  task: { id: string; channel_link: string; target: string; format: string; created_at: string };
  open: boolean;
  onOpen: () => void;
}) {
  const qc = useQueryClient();
  const listR = useServerFn(listProofRuns);
  const run = useServerFn(runProofTask);
  const runsQ = useQuery({
    queryKey: ["proof-runs", task.id],
    queryFn: () => listR({ data: { taskId: task.id } }),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
  const runs = runsQ.data ?? [];
  const [rerunning, setRerunning] = useState(false);

  const rerun = async () => {
    setRerunning(true);
    try {
      const r = await run({ data: { taskId: task.id } });
      toast.success(`Re-ran ${r.ran} pending/failed runs`);
      await qc.invalidateQueries({ queryKey: ["proof-runs", task.id] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent"
      >
        <div>
          <div className="text-sm font-medium">{task.channel_link}</div>
          <div className="text-xs text-muted-foreground">
            → {task.target} · {task.format} · {new Date(task.created_at).toLocaleString()}
          </div>
        </div>
        <span className="text-xs text-[#5eb0ef]">{open ? "hide" : "view"}</span>
      </button>
      {open && (
        <div className="border-t border-border p-3">
          <div className="mb-2 flex justify-end">
            <Button size="sm" variant="outline" onClick={rerun} disabled={rerunning}>
              {rerunning ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
              Retry pending/failed
            </Button>
          </div>
          <div className="space-y-1">
            {runs.map((r: any) => (
              <div key={r.id} className="flex items-center justify-between rounded border border-border/60 px-3 py-2 text-sm">
                <div>
                  <span className="font-medium">
                    {r.telegram_accounts?.first_name || r.telegram_accounts?.username || r.telegram_accounts?.phone || r.account_id.slice(0, 8)}
                  </span>
                  {r.channel_title && (
                    <span className="ml-2 text-xs text-muted-foreground">→ {r.channel_title}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={
                      "text-xs font-semibold uppercase " +
                      (r.status === "sent"
                        ? "text-green-500"
                        : r.status === "failed"
                          ? "text-red-500"
                          : "text-yellow-500")
                    }
                  >
                    {r.status}
                  </span>
                  {r.error && (
                    <span className="max-w-[240px] truncate text-xs text-red-400" title={r.error}>
                      {r.error}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {!runs.length && (
              <p className="text-xs text-muted-foreground">No runs yet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}