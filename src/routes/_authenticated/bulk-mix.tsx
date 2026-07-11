import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { runReactionsLive } from "@/lib/reactions.functions";
import { runViewBoostLive } from "@/lib/view-boost.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader2, Smile, Eye, Trash2, Plus, X } from "lucide-react";

export const Route = createFileRoute("/_authenticated/bulk-mix")({
  head: () => ({
    meta: [
      { title: "Bulk Mix — Reactions & Views" },
      { name: "description", content: "Per-post reactions and view boost across many accounts." },
    ],
  }),
  component: BulkMix,
});

type Emoji = { emoji: string; weight: number };
type LogRow = { accountId: string | null; target: string | null; level: string; message: string };
type Account = { id: string; first_name: string | null; phone: string; username: string | null; status: string };

function parsePostLink(raw: string): { chat: string; msgId: number } | null {
  const stripped = raw.trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const msgId = Number(parts[parts.length - 1]);
  if (!Number.isInteger(msgId) || msgId <= 0) return null;
  const chat = parts[0] === "c" && parts.length >= 3 ? `c/${parts[1]}` : parts[0];
  return { chat, msgId };
}

function AccountsPopover({
  accounts, selected, setSelected,
}: {
  accounts: Account[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const all = selected.size > 0 && selected.size === accounts.length;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Accounts ({selected.size}/{accounts.length})</Label>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
            onClick={() => setSelected(all ? new Set() : new Set(accounts.map((a) => a.id)))}>
            {all ? "None" : "All"}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Pick"}
          </Button>
        </div>
      </div>
      {open && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-2">
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted">
              <Checkbox
                checked={selected.has(a.id)}
                onCheckedChange={() => {
                  const n = new Set(selected);
                  n.has(a.id) ? n.delete(a.id) : n.add(a.id);
                  setSelected(n);
                }}
              />
              <span>{a.first_name ?? a.phone} {a.username ? `@${a.username}` : ""}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function LogList({ logs }: { logs: LogRow[] }) {
  if (!logs.length) return null;
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-2 text-xs">
      {logs.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${l.level === "success" ? "bg-green-500" : l.level === "error" ? "bg-red-500" : "bg-yellow-500"}`} />
          <span className="text-muted-foreground">{l.accountId ? l.accountId.slice(0, 8) : "—"}</span>
          <span className="truncate">{l.message}</span>
        </div>
      ))}
    </div>
  );
}

function BulkMix() {
  const listFn = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listFn() });
  const accounts = accountsQ.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">Bulk Mix</h1>
      <p className="text-sm text-muted-foreground">Har post ke liye alag link, emojis/spread aur accounts choose karo.</p>
      <Tabs defaultValue="reactions">
        <TabsList>
          <TabsTrigger value="reactions"><Smile className="mr-1 h-4 w-4" /> Reactions Mix</TabsTrigger>
          <TabsTrigger value="views"><Eye className="mr-1 h-4 w-4" /> View Boost</TabsTrigger>
        </TabsList>
        <TabsContent value="reactions"><ReactionsMix accounts={accounts} /></TabsContent>
        <TabsContent value="views"><ViewBoost accounts={accounts} /></TabsContent>
      </Tabs>
    </div>
  );
}

type ReactionPost = {
  id: string;
  link: string;
  emojis: Emoji[];
  spread: number;
  big: boolean;
  randomize: boolean;
  selected: Set<string>;
  busy: boolean;
  logs: LogRow[];
};

function newReactionPost(): ReactionPost {
  return {
    id: crypto.randomUUID(),
    link: "",
    emojis: [{ emoji: "👍", weight: 7 }, { emoji: "❤️", weight: 3 }],
    spread: 30,
    big: false,
    randomize: true,
    selected: new Set(),
    busy: false,
    logs: [],
  };
}

function ReactionsMix({ accounts }: { accounts: Account[] }) {
  const runFn = useServerFn(runReactionsLive);
  const [posts, setPosts] = useState<ReactionPost[]>([newReactionPost()]);

  const update = (id: string, patch: Partial<ReactionPost>) =>
    setPosts((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const runOne = async (post: ReactionPost) => {
    const parsed = parsePostLink(post.link);
    if (!parsed) return toast.error("Invalid post link");
    if (post.selected.size === 0) return toast.error("Select at least one account");
    update(post.id, { busy: true, logs: [] });
    try {
      const res = await runFn({
        data: {
          source: parsed,
          accountIds: Array.from(post.selected),
          emojis: post.emojis,
          spreadSeconds: post.spread,
          randomizeOrder: post.randomize,
          big: post.big,
        },
      });
      update(post.id, {
        busy: false,
        logs: [
          { accountId: null, target: post.link, level: "info", message: `▶ ok ${res.ok} / fail ${res.fail}` },
          ...res.logs,
        ],
      });
      toast.success(`${parsed.chat}/${parsed.msgId}: ok ${res.ok}, fail ${res.fail}`);
    } catch (e) {
      update(post.id, { busy: false, logs: [{ accountId: null, target: post.link, level: "error", message: (e as Error).message }] });
      toast.error((e as Error).message);
    }
  };

  const runAll = async () => {
    await Promise.all(posts.map(runOne));
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setPosts([...posts, newReactionPost()])}>
          <Plus className="mr-1 h-4 w-4" /> Add post
        </Button>
        <Button size="sm" onClick={runAll} disabled={posts.some((p) => p.busy)}>
          <Smile className="mr-1 h-4 w-4" /> Run all
        </Button>
      </div>
      {posts.map((post, idx) => (
        <Card key={post.id}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm">Post #{idx + 1}</CardTitle>
            {posts.length > 1 && (
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setPosts(posts.filter((p) => p.id !== post.id))}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Post link</Label>
                <Input value={post.link} onChange={(e) => update(post.id, { link: e.target.value })}
                  placeholder="https://t.me/channel/123" />
              </div>
              <div>
                <Label className="text-xs">Weighted emoji mix</Label>
                <div className="space-y-1">
                  {post.emojis.map((e, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input className="w-20" value={e.emoji} onChange={(ev) => {
                        const n = [...post.emojis]; n[i] = { ...n[i], emoji: ev.target.value }; update(post.id, { emojis: n });
                      }} />
                      <Input className="w-20" type="number" min={1} max={100} value={e.weight} onChange={(ev) => {
                        const n = [...post.emojis]; n[i] = { ...n[i], weight: Number(ev.target.value) || 1 }; update(post.id, { emojis: n });
                      }} />
                      <Button size="icon" variant="ghost" onClick={() => update(post.id, { emojis: post.emojis.filter((_, j) => j !== i) })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" onClick={() => update(post.id, { emojis: [...post.emojis, { emoji: "🔥", weight: 1 }] })}>
                    <Plus className="mr-1 h-4 w-4" /> Add emoji
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Spread (sec)</Label>
                  <Input type="number" min={0} max={3600} value={post.spread} onChange={(e) => update(post.id, { spread: Number(e.target.value) || 0 })} />
                </div>
                <div className="flex items-end gap-3">
                  <label className="flex items-center gap-2 text-xs"><Switch checked={post.big} onCheckedChange={(v) => update(post.id, { big: v })} /> Big</label>
                  <label className="flex items-center gap-2 text-xs"><Switch checked={post.randomize} onCheckedChange={(v) => update(post.id, { randomize: v })} /> Shuffle</label>
                </div>
              </div>
              <Button size="sm" onClick={() => runOne(post)} disabled={post.busy}>
                {post.busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Smile className="mr-1 h-4 w-4" />}
                React ({post.selected.size} acc)
              </Button>
            </div>
            <div className="space-y-2">
              <AccountsPopover accounts={accounts} selected={post.selected} setSelected={(s) => update(post.id, { selected: s })} />
              <LogList logs={post.logs} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

type ViewPost = {
  id: string;
  link: string;
  spread: number;
  selected: Set<string>;
  busy: boolean;
  logs: LogRow[];
};

function newViewPost(): ViewPost {
  return { id: crypto.randomUUID(), link: "", spread: 60, selected: new Set(), busy: false, logs: [] };
}

function ViewBoost({ accounts }: { accounts: Account[] }) {
  const runFn = useServerFn(runViewBoostLive);
  const [posts, setPosts] = useState<ViewPost[]>([newViewPost()]);

  const update = (id: string, patch: Partial<ViewPost>) =>
    setPosts((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const runOne = async (post: ViewPost) => {
    const parsed = parsePostLink(post.link);
    if (!parsed) return toast.error("Invalid post link");
    if (post.selected.size === 0) return toast.error("Select at least one account");
    update(post.id, { busy: true, logs: [] });
    try {
      const res = await runFn({
        data: {
          source: { chat: parsed.chat, msgIds: [parsed.msgId] },
          accountIds: Array.from(post.selected),
          spreadSeconds: post.spread,
        },
      });
      update(post.id, {
        busy: false,
        logs: [
          { accountId: null, target: post.link, level: "info", message: `▶ ok ${res.ok} / fail ${res.fail}` },
          ...res.logs,
        ],
      });
      toast.success(`${parsed.chat}/${parsed.msgId}: ok ${res.ok}, fail ${res.fail}`);
    } catch (e) {
      update(post.id, { busy: false, logs: [{ accountId: null, target: post.link, level: "error", message: (e as Error).message }] });
      toast.error((e as Error).message);
    }
  };

  const runAll = async () => {
    await Promise.all(posts.map(runOne));
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setPosts([...posts, newViewPost()])}>
          <Plus className="mr-1 h-4 w-4" /> Add post
        </Button>
        <Button size="sm" onClick={runAll} disabled={posts.some((p) => p.busy)}>
          <Eye className="mr-1 h-4 w-4" /> Run all
        </Button>
      </div>
      {posts.map((post, idx) => (
        <Card key={post.id}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm">Post #{idx + 1}</CardTitle>
            {posts.length > 1 && (
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setPosts(posts.filter((p) => p.id !== post.id))}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Post link</Label>
                <Input value={post.link} onChange={(e) => update(post.id, { link: e.target.value })}
                  placeholder="https://t.me/channel/123" />
              </div>
              <div>
                <Label className="text-xs">Spread (sec)</Label>
                <Input type="number" min={0} max={3600} value={post.spread} onChange={(e) => update(post.id, { spread: Number(e.target.value) || 0 })} />
              </div>
              <Button size="sm" onClick={() => runOne(post)} disabled={post.busy}>
                {post.busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}
                Boost ({post.selected.size} acc)
              </Button>
            </div>
            <div className="space-y-2">
              <AccountsPopover accounts={accounts} selected={post.selected} setSelected={(s) => update(post.id, { selected: s })} />
              <LogList logs={post.logs} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
