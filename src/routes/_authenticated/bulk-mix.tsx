import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { runReactionsLive } from "@/lib/reactions.functions";
import { runViewBoostLive } from "@/lib/view-boost.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader2, Smile, Eye, Trash2, Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/bulk-mix")({
  head: () => ({
    meta: [
      { title: "Bulk Mix — Reactions & Views" },
      { name: "description", content: "Weighted-mix reactions and view boost across many accounts, time-spread." },
    ],
  }),
  component: BulkMix,
});

type Emoji = { emoji: string; weight: number };
type LogRow = { accountId: string | null; target: string | null; level: string; message: string };

// Parse Telegram post links / "chat/msgId" pairs into { chat, msgId } entries.
// Accepts: https://t.me/name/123, https://t.me/c/123456/789,
// https://t.me/name/topic/789 (msgId = last integer), @name/123, name/123
function parsePostLinks(input: string): { chat: string; msgId: number; raw: string }[] {
  const out: { chat: string; msgId: number; raw: string }[] = [];
  const seen = new Set<string>();
  for (const line of input.split(/[\s,]+/)) {
    const raw = line.trim();
    if (!raw) continue;
    const stripped = raw
      .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "")
      .replace(/^@/, "")
      .replace(/\?.*$/, "")
      .replace(/\/+$/, "");
    const parts = stripped.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    const msgId = Number(parts[parts.length - 1]);
    if (!Number.isInteger(msgId) || msgId <= 0) continue;
    let chat: string;
    if (parts[0] === "c" && parts.length >= 3) {
      chat = `c/${parts[1]}`;
    } else {
      chat = parts[0];
    }
    const key = `${chat}#${msgId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chat, msgId, raw });
  }
  return out;
}

function AccountsPicker({
  accounts, selected, setSelected,
}: {
  accounts: { id: string; first_name: string | null; phone: string; username: string | null; status: string }[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
}) {
  const all = selected.size > 0 && selected.size === accounts.length;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Accounts ({selected.size}/{accounts.length})</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setSelected(all ? new Set() : new Set(accounts.map((a) => a.id)))}>
          {all ? "Unselect all" : "Select all"}
        </Button>
      </CardHeader>
      <CardContent className="max-h-72 space-y-1 overflow-y-auto">
        {accounts.map((a) => (
          <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted">
            <Checkbox
              checked={selected.has(a.id)}
              onCheckedChange={() => {
                const n = new Set(selected);
                n.has(a.id) ? n.delete(a.id) : n.add(a.id);
                setSelected(n);
              }}
            />
            <span className="text-sm">{a.first_name ?? a.phone} {a.username ? `@${a.username}` : ""}</span>
            <span className="ml-auto text-xs text-muted-foreground">{a.status}</span>
          </label>
        ))}
      </CardContent>
    </Card>
  );
}

function LogList({ logs }: { logs: LogRow[] }) {
  if (!logs.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Live Log</CardTitle></CardHeader>
      <CardContent className="max-h-72 space-y-1 overflow-y-auto text-sm">
        {logs.map((l, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${l.level === "success" ? "bg-green-500" : l.level === "error" ? "bg-red-500" : "bg-yellow-500"}`} />
            <span className="text-xs text-muted-foreground">{l.accountId ? l.accountId.slice(0, 8) : "—"}</span>
            <span className="truncate">{l.message}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function BulkMix() {
  const listFn = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listFn() });
  const accounts = accountsQ.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">Bulk Mix</h1>
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

function ReactionsMix({ accounts }: { accounts: any[] }) {
  const runFn = useServerFn(runReactionsLive);
  const [links, setLinks] = useState("");
  const [emojis, setEmojis] = useState<Emoji[]>([{ emoji: "👍", weight: 7 }, { emoji: "❤️", weight: 3 }]);
  const [spread, setSpread] = useState(30);
  const [big, setBig] = useState(false);
  const [randomize, setRandomize] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);

  const posts = useMemo(() => parsePostLinks(links), [links]);
  const canRun = posts.length > 0 && selected.size > 0 && emojis.every((e) => e.emoji && e.weight > 0);

  const run = async () => {
    setBusy(true);
    setLogs([]);
    let totalOk = 0;
    let totalFail = 0;
    const allLogs: LogRow[] = [];
    try {
      await Promise.all(
        posts.map(async (p) => {
          try {
            const res = await runFn({
              data: {
                source: { chat: p.chat, msgId: p.msgId },
                accountIds: Array.from(selected),
                emojis,
                spreadSeconds: spread,
                randomizeOrder: randomize,
                big,
              },
            });
            totalOk += res.ok;
            totalFail += res.fail;
            allLogs.push(
              { accountId: null, target: p.raw, level: "info", message: `▶ ${p.raw} — ok ${res.ok} / fail ${res.fail}` },
              ...res.logs,
            );
          } catch (e) {
            totalFail += selected.size;
            allLogs.push({ accountId: null, target: p.raw, level: "error", message: `${p.raw}: ${(e as Error).message}` });
          }
          setLogs([...allLogs]);
        }),
      );
      toast.success(`Reacted across ${posts.length} post(s): ok ${totalOk}, fail ${totalFail}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Target & Mix</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Post links (one per line, or comma/space separated)</Label>
            <Textarea
              rows={4}
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              placeholder={"https://t.me/channel/123\nhttps://t.me/c/1234567890/45\n@channel/678"}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Parsed: {posts.length} post{posts.length === 1 ? "" : "s"}
              {posts.length > 0 && ` — ${posts.slice(0, 3).map((p) => `${p.chat}/${p.msgId}`).join(", ")}${posts.length > 3 ? "…" : ""}`}
            </p>
          </div>
          <div>
            <Label>Weighted emoji mix</Label>
            <div className="space-y-1">
              {emojis.map((e, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="w-20" value={e.emoji} onChange={(ev) => {
                    const n = [...emojis]; n[i] = { ...n[i], emoji: ev.target.value }; setEmojis(n);
                  }} />
                  <Input className="w-20" type="number" min={1} max={100} value={e.weight} onChange={(ev) => {
                    const n = [...emojis]; n[i] = { ...n[i], weight: Number(ev.target.value) || 1 }; setEmojis(n);
                  }} />
                  <Button size="icon" variant="ghost" onClick={() => setEmojis(emojis.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setEmojis([...emojis, { emoji: "🔥", weight: 1 }])}>
                <Plus className="mr-1 h-4 w-4" /> Add emoji
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Spread (sec)</Label><Input type="number" min={0} max={3600} value={spread} onChange={(e) => setSpread(Number(e.target.value) || 0)} /></div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 text-sm"><Switch checked={big} onCheckedChange={setBig} /> Big</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={randomize} onCheckedChange={setRandomize} /> Shuffle</label>
            </div>
          </div>
          <Button onClick={run} disabled={!canRun || busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Smile className="mr-1 h-4 w-4" />}
            React from {selected.size} account{selected.size === 1 ? "" : "s"} × {posts.length} post{posts.length === 1 ? "" : "s"}
          </Button>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <AccountsPicker accounts={accounts} selected={selected} setSelected={setSelected} />
        <LogList logs={logs} />
      </div>
    </div>
  );
}

function ViewBoost({ accounts }: { accounts: any[] }) {
  const runFn = useServerFn(runViewBoostLive);
  const [links, setLinks] = useState("");
  const [spread, setSpread] = useState(60);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);

  // Group parsed links by chat so we can pass msgIds[] per chat in one call.
  const grouped = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const p of parsePostLinks(links)) {
      const arr = map.get(p.chat) ?? [];
      if (!arr.includes(p.msgId) && arr.length < 20) arr.push(p.msgId);
      map.set(p.chat, arr);
    }
    return Array.from(map.entries()).map(([chat, msgIds]) => ({ chat, msgIds }));
  }, [links]);
  const totalPosts = grouped.reduce((n, g) => n + g.msgIds.length, 0);
  const canRun = grouped.length > 0 && selected.size > 0;

  const run = async () => {
    setBusy(true);
    setLogs([]);
    let totalOk = 0;
    let totalFail = 0;
    const allLogs: LogRow[] = [];
    try {
      await Promise.all(
        grouped.map(async (g) => {
          try {
            const res = await runFn({
              data: {
                source: { chat: g.chat, msgIds: g.msgIds },
                accountIds: Array.from(selected),
                spreadSeconds: spread,
              },
            });
            totalOk += res.ok;
            totalFail += res.fail;
            allLogs.push(
              { accountId: null, target: `${g.chat}/${g.msgIds.join(",")}`, level: "info", message: `▶ ${g.chat} [${g.msgIds.join(",")}] — ok ${res.ok} / fail ${res.fail}` },
              ...res.logs,
            );
          } catch (e) {
            totalFail += selected.size;
            allLogs.push({ accountId: null, target: g.chat, level: "error", message: `${g.chat}: ${(e as Error).message}` });
          }
          setLogs([...allLogs]);
        }),
      );
      toast.success(`Views on ${totalPosts} post(s): ok ${totalOk}, fail ${totalFail}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Target</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Post links (one per line — mix any channels)</Label>
            <Textarea
              rows={5}
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              placeholder={"https://t.me/channel/123\nhttps://t.me/channel/124\nhttps://t.me/c/1234567890/45"}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Parsed: {totalPosts} post{totalPosts === 1 ? "" : "s"} across {grouped.length} chat{grouped.length === 1 ? "" : "s"}
              {grouped.length > 0 && ` — ${grouped.slice(0, 2).map((g) => `${g.chat} [${g.msgIds.join(",")}]`).join("; ")}${grouped.length > 2 ? "…" : ""}`}
            </p>
          </div>
          <div><Label>Spread (sec)</Label><Input type="number" min={0} max={3600} value={spread} onChange={(e) => setSpread(Number(e.target.value) || 0)} /></div>
          <Button onClick={run} disabled={!canRun || busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}
            Boost views from {selected.size} account{selected.size === 1 ? "" : "s"} × {totalPosts} post{totalPosts === 1 ? "" : "s"}
          </Button>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <AccountsPicker accounts={accounts} selected={selected} setSelected={setSelected} />
        <LogList logs={logs} />
      </div>
    </div>
  );
}