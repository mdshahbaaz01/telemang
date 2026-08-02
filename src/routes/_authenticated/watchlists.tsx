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
import { requireAdminBeforeLoad } from "@/lib/access-guard";
import { AccountRangeControls, pickRange } from "@/components/AccountRangeControls";
import { AccountIdPaste } from "@/components/AccountIdPaste";

export const Route = createFileRoute("/_authenticated/watchlists")({
  beforeLoad: requireAdminBeforeLoad,
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
  const PRESETS = ["🔥", "❤️", "👍", "🎉", "🚀", "💯", "👀", "😍", "🤔", "😂", "🙏", "⚡"];
  const toggleEmoji = (e: string) => {
    const list = form.emoji.split(/[,\s]+/).filter(Boolean);
    const next = list.includes(e) ? list.filter((x) => x !== e) : [...list, e];
    setForm({ ...form, emoji: next.join(", ") });
  };
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
              <Label>Reaction emoji(s)</Label>
              <Input
                value={form.emoji}
                onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                placeholder="🔥, ❤️, 👍"
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {PRESETS.map((e) => {
                  const active = form.emoji.split(/[,\s]+/).includes(e);
                  return (
                    <button
                      key={e}
                      type="button"
                      onClick={() => toggleEmoji(e)}
                      className={`rounded border px-2 py-0.5 text-sm ${active ? "border-primary bg-primary/10" : ""}`}
                    >
                      {e}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Multiple emojis = each account picks one at random for a natural spread.
              </div>
            </div>
          </div>
          <div>
            <Label>Accounts</Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <AccountRangeControls
                total={(aQ.data ?? []).length}
                onApply={(s, e, order) =>
                  setForm((f) => ({
                    ...f,
                    accountIds: pickRange(aQ.data ?? [], s, e, order).map((a) => a.id),
                  }))
                }
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => setForm((f) => ({ ...f, accountIds: (aQ.data ?? []).map((a) => a.id) }))}
              >
                Select all
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setForm((f) => ({ ...f, accountIds: [] }))}>
                Deselect all
              </Button>
            </div>
            <AccountIdPaste
              accounts={(aQ.data ?? []) as any}
              className="mt-2"
              onSelect={(ids) =>
                setForm((f) => ({ ...f, accountIds: Array.from(new Set([...f.accountIds, ...ids])) }))
              }
            />
            <div className="mt-2 max-h-40 overflow-y-auto rounded border p-2">
              {(aQ.data ?? []).map((a, i) => (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <Checkbox checked={form.accountIds.includes(a.id)} onCheckedChange={() => toggleAccount(a.id)} />
                  <span className="text-muted-foreground">#{i + 1}</span>
                  <span>{a.first_name ?? a.username ?? a.phone ?? a.id.slice(0, 8)}</span>
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
