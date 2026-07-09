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
  const [chat, setChat] = useState("");
  const [msgId, setMsgId] = useState("");
  const [emojis, setEmojis] = useState<Emoji[]>([{ emoji: "👍", weight: 7 }, { emoji: "❤️", weight: 3 }]);
  const [spread, setSpread] = useState(30);
  const [big, setBig] = useState(false);
  const [randomize, setRandomize] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);

  const canRun = useMemo(
    () => chat.trim() && Number(msgId) > 0 && selected.size > 0 && emojis.every((e) => e.emoji && e.weight > 0),
    [chat, msgId, selected, emojis],
  );

  const run = async () => {
    setBusy(true);
    setLogs([]);
    try {
      const res = await runFn({
        data: {
          source: { chat: chat.trim(), msgId: Number(msgId) },
          accountIds: Array.from(selected),
          emojis,
          spreadSeconds: spread,
          randomizeOrder: randomize,
          big,
        },
      });
      setLogs(res.logs);
      toast.success(`Reacted: ok ${res.ok}, fail ${res.fail}`);
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
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2"><Label>Chat</Label><Input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="@channel or c/123456" /></div>
            <div><Label>Msg ID</Label><Input value={msgId} onChange={(e) => setMsgId(e.target.value.replace(/\D/g, ""))} /></div>
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
            React from {selected.size} account{selected.size === 1 ? "" : "s"}
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
  const [chat, setChat] = useState("");
  const [ids, setIds] = useState("");
  const [spread, setSpread] = useState(60);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);

  const msgIds = useMemo(
    () => ids.split(/[\s,]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20),
    [ids],
  );
  const canRun = chat.trim() && msgIds.length && selected.size > 0;

  const run = async () => {
    setBusy(true);
    setLogs([]);
    try {
      const res = await runFn({
        data: {
          source: { chat: chat.trim(), msgIds },
          accountIds: Array.from(selected),
          spreadSeconds: spread,
        },
      });
      setLogs(res.logs);
      toast.success(`Views: ok ${res.ok}, fail ${res.fail}`);
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
          <div><Label>Chat</Label><Input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="@channel" /></div>
          <div>
            <Label>Message IDs (comma or space separated, up to 20)</Label>
            <Input value={ids} onChange={(e) => setIds(e.target.value)} placeholder="123, 124, 125" />
            <p className="mt-1 text-xs text-muted-foreground">Parsed: {msgIds.join(", ") || "—"}</p>
          </div>
          <div><Label>Spread (sec)</Label><Input type="number" min={0} max={3600} value={spread} onChange={(e) => setSpread(Number(e.target.value) || 0)} /></div>
          <Button onClick={run} disabled={!canRun || busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}
            Boost views from {selected.size} account{selected.size === 1 ? "" : "s"}
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