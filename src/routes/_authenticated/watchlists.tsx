import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Eye, RefreshCw, Trash2 } from "lucide-react";
import { listWatchlists, saveWatchlist, deleteWatchlist, scanWatchlist } from "@/lib/watchlists.functions";
import { listAccounts } from "@/lib/accounts.functions";

export const Route = createFileRoute("/_authenticated/watchlists")({
  component: WatchlistsPage,
});

function WatchlistsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listWatchlists);
  const saveFn = useServerFn(saveWatchlist);
  const delFn = useServerFn(deleteWatchlist);
  const scanFn = useServerFn(scanWatchlist);
  const accFn = useServerFn(listAccounts);

  const wQ = useQuery({ queryKey: ["watchlists"], queryFn: () => listFn() });
  const aQ = useQuery({ queryKey: ["accounts"], queryFn: () => accFn() });

  const [form, setForm] = useState({ name: "", chat: "", emoji: "🔥", accountIds: [] as string[], enabled: true });
  const [scanning, setScanning] = useState<string | null>(null);

  const create = async () => {
    if (!form.name.trim() || !form.chat.trim() || form.accountIds.length === 0) {
      return toast.error("Fill name, chat, and at least one account");
    }
    try {
      await saveFn({ data: form });
      toast.success("Watchlist saved");
      setForm({ name: "", chat: "", emoji: "🔥", accountIds: [], enabled: true });
      qc.invalidateQueries({ queryKey: ["watchlists"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this watchlist?")) return;
    await delFn({ data: { id } });
    qc.invalidateQueries({ queryKey: ["watchlists"] });
  };

  const scan = async (id: string) => {
    setScanning(id);
    try {
      const res = await scanFn({ data: { id } });
      toast.success(`Scan done: ${res.reacted ?? 0} reacted (${res.newMsgId ? "msg " + res.newMsgId : "no new"})`);
      qc.invalidateQueries({ queryKey: ["watchlists"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(null);
    }
  };

  const toggleAccount = (id: string) =>
    setForm((f) => ({
      ...f,
      accountIds: f.accountIds.includes(id) ? f.accountIds.filter((x) => x !== id) : [...f.accountIds, id],
    }));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Watchlists</h1>
      <p className="text-sm text-muted-foreground">
        Auto-react to new posts in watched channels. Click <b>Scan now</b> to check for the newest post and react
        from every selected account (view bump included).
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New watchlist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My channel" />
            </div>
            <div>
              <Label>Chat (@username, link, or c/123)</Label>
              <Input value={form.chat} onChange={(e) => setForm({ ...form, chat: e.target.value })} placeholder="@mychannel" />
            </div>
            <div>
              <Label>Reaction emoji</Label>
              <Input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} maxLength={8} />
            </div>
          </div>
          <div>
            <Label>Accounts</Label>
            <div className="mt-2 max-h-40 overflow-y-auto rounded border p-2">
              {(aQ.data ?? []).map((a, i) => (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <Checkbox checked={form.accountIds.includes(a.id)} onCheckedChange={() => toggleAccount(a.id)} />
                  <span className="text-muted-foreground">#{i + 1}</span>
                  <span>{a.display_name ?? a.phone_number ?? a.id.slice(0, 8)}</span>
                </label>
              ))}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{form.accountIds.length} selected</div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: !!v })} />
            Enabled
          </label>
          <Button onClick={create}>Save watchlist</Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {(wQ.data ?? []).map((w) => (
          <Card key={w.id}>
            <CardContent className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  <Eye className="h-4 w-4" /> {w.name}
                  {!w.enabled && <Badge variant="outline">Disabled</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {w.chat} · {w.emoji} · {w.accountIds.length} accounts · last msg #{w.lastMsgId || "—"}
                  {w.lastRunAt ? ` · ${new Date(w.lastRunAt).toLocaleString()}` : ""}
                </div>
              </div>
              <Button size="sm" onClick={() => scan(w.id)} disabled={scanning === w.id}>
                <RefreshCw className={`mr-1 h-3 w-3 ${scanning === w.id ? "animate-spin" : ""}`} />
                {scanning === w.id ? "Scanning…" : "Scan now"}
              </Button>
              <Button size="icon" variant="ghost" onClick={() => remove(w.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        ))}
        {(wQ.data ?? []).length === 0 && (
          <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
            No watchlists yet.
          </div>
        )}
      </div>
    </div>
  );
}
