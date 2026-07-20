import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountRangeControls, pickRange } from "@/components/AccountRangeControls";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import { globalSearch } from "@/lib/global-search.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminGate } from "@/components/AdminGate";
import { Loader } from "@/components/ui/loader";
import { ArrowLeft, Search as SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/search")({
  beforeLoad: requireAdminBeforeLoad,
  component: () => (
    <AdminGate>
      <SearchPage />
    </AdminGate>
  ),
});

function SearchPage() {
  const listAcc = useServerFn(listAccounts);
  const search = useServerFn(globalSearch);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });

  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"chats" | "messages" | "users">("chats");
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<Awaited<ReturnType<typeof globalSearch>>["hits"]>([]);
  const [errors, setErrors] = useState<Array<{ accountId: string; message: string }>>([]);

  const toggle = (id: string) => {
    const n = new Set(ids);
    n.has(id) ? n.delete(id) : n.add(id);
    setIds(n);
  };
  const toggleAll = () => {
    const all = accountsQ.data ?? [];
    if (ids.size === all.length) setIds(new Set());
    else setIds(new Set(all.map((a) => a.id)));
  };

  const run = async () => {
    if (!q.trim()) return toast.error("Enter a search query");
    if (ids.size === 0) return toast.error("Pick at least one account");
    setBusy(true);
    try {
      const res = await search({ data: { query: q.trim(), accountIds: [...ids], scope } });
      setHits(res.hits);
      setErrors(res.errors);
      if (!res.hits.length) toast.info("No matches");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 md:px-8">
          <Link to="/dashboard">
            <Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button>
          </Link>
          <h1 className="text-lg font-semibold">Global search</h1>
        </div>
      </header>
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Query</label>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="Search across accounts…"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Scope</label>
            <Tabs value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
              <TabsList>
                <TabsTrigger value="chats">Chats</TabsTrigger>
                <TabsTrigger value="users">Users</TabsTrigger>
                <TabsTrigger value="messages">Messages</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Button onClick={run} disabled={busy}>
            <SearchIcon className="mr-1 h-4 w-4" /> {busy ? "Searching…" : "Search"}
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Accounts ({ids.size}/{accountsQ.data?.length ?? 0})</div>
            <div className="flex items-center gap-2">
              <AccountRangeControls
                total={accountsQ.data?.length ?? 0}
                onApply={(s, e, order) => {
                  const picked = pickRange(accountsQ.data ?? [], s, e, order).map((a) => a.id);
                  setIds(new Set(picked));
                }}
              />
              <Button size="sm" variant="ghost" onClick={toggleAll} disabled={!accountsQ.data?.length}>
                {ids.size === (accountsQ.data?.length ?? -1) ? "Deselect all" : "Select all"}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(accountsQ.data ?? []).map((a) => (
              <label
                key={a.id}
                className="flex cursor-pointer items-center gap-2 rounded border border-border px-2 py-1 text-xs"
              >
                <Checkbox checked={ids.has(a.id)} onCheckedChange={() => toggle(a.id)} />
                <span className="max-w-[160px] truncate">
                  {a.first_name || a.username || a.phone}
                </span>
              </label>
            ))}
          </div>
        </div>

        {busy && <Loader size="sm" />}

        {errors.length > 0 && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {errors.map((e, i) => (
              <div key={i}>[{e.accountId.slice(0, 6)}] {e.message}</div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {hits.length === 0 && !busy ? (
            <p className="text-sm text-muted-foreground">No results yet.</p>
          ) : (
            hits.map((h, i) => (
              <div key={i} className="rounded border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{h.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      [{h.accountName}] · {h.kind}
                      {h.subtitle ? ` · ${h.subtitle}` : ""}
                      {h.messageId ? ` · msg ${h.messageId}` : ""}
                    </div>
                    {h.snippet && <div className="mt-1 text-xs">{h.snippet}</div>}
                  </div>
                  <Link
                    to="/accounts/$id"
                    params={{ id: h.accountId }}
                    className="text-xs text-primary hover:underline"
                  >
                    Open
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}