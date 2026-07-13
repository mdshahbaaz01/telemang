import { useEffect, useState, useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listDialogs } from "@/lib/tg-viewer.functions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type Account = { id: string; first_name?: string | null; username?: string | null; phone?: string | null };
type DialogItem = {
  peerKey: string;
  title: string;
  username: string | null;
  kind: "user" | "group" | "channel";
  isBot?: boolean;
  photoDataUrl?: string | null;
};

function dialogToTarget(d: DialogItem): string | null {
  if (d.username) return "@" + d.username;
  // peerKey formats: "u:<id>", "c:<id>" (channel/supergroup), "g:<id>" (legacy chat)
  const [prefix, id] = d.peerKey.split(":");
  if (prefix === "c") return `c/${id}`;
  if (prefix === "u") return id; // may fail to resolve without cache
  if (prefix === "g") return id;
  return null;
}

export function TargetsPicker({
  accounts,
  defaultAccountId,
  onAdd,
}: {
  accounts: Account[];
  defaultAccountId?: string;
  onAdd: (targets: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState<string>(defaultAccountId || accounts[0]?.id || "");
  const [loading, setLoading] = useState(false);
  const [dialogs, setDialogs] = useState<DialogItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "user" | "bot" | "group" | "channel">("all");
  const listDialogsFn = useServerFn(listDialogs);

  useEffect(() => {
    if (defaultAccountId) setAccountId(defaultAccountId);
  }, [defaultAccountId]);

  const load = async (id: string) => {
    if (!id) return;
    setLoading(true);
    setDialogs([]);
    setSelected(new Set());
    try {
      // Load up to 3000 dialogs without photos for speed (users with 1000+ chats).
      const res: any = await listDialogsFn({ data: { accountId: id, limit: 3000, withPhotos: false } });
      setDialogs(res.dialogs ?? []);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load chats");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && accountId) load(accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return dialogs.filter((d) => {
      if (filter === "bot") {
        if (!d.isBot) return false;
      } else if (filter === "user") {
        if (d.kind !== "user" || d.isBot) return false;
      } else if (filter !== "all" && d.kind !== filter) {
        return false;
      }
      if (!q) return true;
      return (
        d.title.toLowerCase().includes(q) ||
        (d.username ?? "").toLowerCase().includes(q)
      );
    });
  }, [dialogs, search, filter]);

  const toggle = (key: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const confirm = () => {
    const chosen = dialogs.filter((d) => selected.has(d.peerKey));
    const targets = chosen.map(dialogToTarget).filter((x): x is string => !!x);
    if (!targets.length) {
      toast.error("Nothing selected");
      return;
    }
    onAdd(targets);
    setOpen(false);
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Pick from account chats
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Pick chats / groups / channels</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 flex-1 overflow-hidden">
            <div className="flex gap-2 flex-wrap items-center">
              <select
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.first_name || a.username || a.phone}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => load(accountId)}
                disabled={loading}
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Reload"}
              </Button>
              <div className="flex gap-1 ml-auto text-xs">
                {(["all", "user", "bot", "group", "channel"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFilter(k)}
                    className={`px-2 py-1 rounded ${filter === k ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <Input
              placeholder="Search title or @username…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex-1 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {loading && (
                <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
              )}
              {!loading && filtered.length === 0 && (
                <div className="p-6 text-center text-sm text-muted-foreground">No chats found</div>
              )}
              {filtered.map((d) => {
                const checked = selected.has(d.peerKey);
                return (
                  <label
                    key={d.peerKey}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(d.peerKey)}
                    />
                    {d.photoDataUrl ? (
                      <img src={d.photoDataUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs">
                        {d.title.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{d.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {d.username ? "@" + d.username : dialogToTarget(d) ?? "—"} · {d.isBot ? "bot" : d.kind}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-muted-foreground" aria-live="polite">
                <span className="font-medium text-foreground">{selected.size}</span> selected
                {" · "}
                {filtered.filter((d) => selected.has(d.peerKey)).length} in view
                {" · "}
                {filtered.length}/{dialogs.length} shown
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSelected((s) => {
                      const keys = filtered.map((d) => d.peerKey);
                      const allOn = keys.every((k) => s.has(k));
                      const n = new Set(s);
                      if (allOn) keys.forEach((k) => n.delete(k));
                      else keys.forEach((k) => n.add(k));
                      return n;
                    })
                  }
                  disabled={!filtered.length}
                >
                  {filtered.length > 0 && filtered.every((d) => selected.has(d.peerKey))
                    ? "Deselect all"
                    : "Select all"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                  disabled={!selected.size}
                >
                  Clear
                </Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" onClick={confirm} disabled={!selected.size}>
                  Add to targets
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}