import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import { listDialogs, runCleanup } from "@/lib/cleanup.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ArrowLeft, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/_authenticated/cleanup")({
  component: () => (
    <AdminGate>
      <Cleanup />
    </AdminGate>
  ),
});

type Action = "leave" | "block" | "deleteHistory";
type Filter = "all" | "channel" | "megagroup" | "chat" | "bot" | "user";

function Cleanup() {
  const listAcc = useServerFn(listAccounts);
  const listDlg = useServerFn(listDialogs);
  const runFn = useServerFn(runCleanup);

  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const [accountId, setAccountId] = useState<string>("");
  const [filter, setFilter] = useState<Filter>("all");
  const [action, setAction] = useState<Action>("leave");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<
    { target: string; ok: boolean; error?: string }[] | null
  >(null);

  const dialogsQ = useQuery({
    queryKey: ["dialogs", accountId],
    enabled: !!accountId,
    queryFn: () => listDlg({ data: { accountId } }),
  });

  const filtered = useMemo(() => {
    const rows = dialogsQ.data ?? [];
    return rows.filter((r) => {
      if (action === "leave" && !["channel", "megagroup", "chat"].includes(r.type))
        return false;
      if (action === "block" && !["user", "bot"].includes(r.type)) return false;
      if (filter !== "all" && r.type !== filter) return false;
      if (query) {
        const q = query.toLowerCase();
        return (
          r.title.toLowerCase().includes(q) ||
          (r.username?.toLowerCase().includes(q) ?? false)
        );
      }
      return true;
    });
  }, [dialogsQ.data, filter, query, action]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) =>
      s.size === filtered.length ? new Set() : new Set(filtered.map((r) => r.id)),
    );

  const run = useMutation({
    mutationFn: async () => {
      const targets = Array.from(selected);
      if (!targets.length) throw new Error("Select at least one item");
      return runFn({ data: { accountId, targets, action } });
    },
    onSuccess: (r) => {
      setResults(r.results);
      const ok = r.results.filter((x) => x.ok).length;
      toast.success(`${ok}/${r.results.length} succeeded`);
      setSelected(new Set());
      dialogsQ.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const actionLabel: Record<Action, string> = {
    leave: "Leave selected",
    block: "Block selected",
    deleteHistory: "Delete history",
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 md:px-8">
          <Link to="/dashboard">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">Cleanup</h1>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 md:px-8">
        <div className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Account</label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger><SelectValue placeholder="Pick account" /></SelectTrigger>
              <SelectContent>
                {accountsQ.data?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.first_name || a.username || a.phone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Action</label>
            <Select value={action} onValueChange={(v) => { setAction(v as Action); setSelected(new Set()); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="leave">Leave channels/groups</SelectItem>
                <SelectItem value="block">Block bots/users</SelectItem>
                <SelectItem value="deleteHistory">Delete history</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Filter</label>
            <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="channel">Channels</SelectItem>
                <SelectItem value="megagroup">Supergroups</SelectItem>
                <SelectItem value="chat">Basic groups</SelectItem>
                <SelectItem value="bot">Bots</SelectItem>
                <SelectItem value="user">Users</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Search</label>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title or @username" />
          </div>
        </div>

        {!accountId ? (
          <p className="text-sm text-muted-foreground">Select an account to load its chats.</p>
        ) : dialogsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading chats…</p>
        ) : dialogsQ.error ? (
          <p className="text-sm text-destructive">{(dialogsQ.error as Error).message}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={toggleAll}>
                  {selected.size === filtered.length && filtered.length > 0 ? "Deselect all" : "Select all"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => dialogsQ.refetch()}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
                </Button>
                <span className="text-xs text-muted-foreground">
                  {selected.size} selected · {filtered.length} shown
                </span>
              </div>
              <Button
                onClick={() => run.mutate()}
                disabled={run.isPending || !selected.size}
                variant={action === "block" || action === "deleteHistory" ? "destructive" : "default"}
              >
                {run.isPending ? "Running…" : `${actionLabel[action]} (${selected.size})`}
              </Button>
            </div>

            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {filtered.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Nothing matches.</p>
              ) : filtered.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-3 p-3">
                  <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.type}{r.username ? ` · @${r.username}` : ""}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            {results && (
              <div className="rounded-lg border border-border bg-card p-4">
                <h3 className="mb-2 font-semibold">Last run</h3>
                <ul className="space-y-1 text-sm">
                  {results.map((r, i) => (
                    <li key={i} className={r.ok ? "text-foreground" : "text-destructive"}>
                      {r.ok ? "✓" : "✗"} {r.target}
                      {r.error ? ` — ${r.error}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}