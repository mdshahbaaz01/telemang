import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import { createJoinTask, parseTargets } from "@/lib/tasks.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { AdminGate } from "@/components/AdminGate";

export const Route = createFileRoute("/_authenticated/tasks/new")({
  component: () => (
    <AdminGate>
      <NewTaskPage />
    </AdminGate>
  ),
});

function NewTaskPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const listAcc = useServerFn(listAccounts);
  const create = useServerFn(createJoinTask);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const accounts = accountsQ.data ?? [];

  const [name, setName] = useState("");
  const [targets, setTargets] = useState("");
  const [minDelay, setMinDelay] = useState("15");
  const [maxDelay, setMaxDelay] = useState("45");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setSelectedIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allSelected = accounts.length > 0 && selectedIds.length === accounts.length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseTargets(targets);
    const min = Math.max(0, Math.trunc(Number(minDelay) || 0));
    const max = Math.max(min, Math.trunc(Number(maxDelay) || min));
    if (!parsed.length) return toast.error("Add at least one target");
    if (!selectedIds.length) return toast.error("Pick at least one account");
    setBusy(true);
    const groupId = crypto.randomUUID();
    try {
      const results = await Promise.allSettled(
        selectedIds.map((accountId) => {
          const acc = accounts.find((a) => a.id === accountId);
          const label = acc?.username || acc?.first_name || acc?.phone || "acct";
          return create({
            data: {
              accountId,
              name: selectedIds.length > 1 ? `${name} · ${label}` : name,
              targets: parsed,
              minDelay: min,
              maxDelay: max,
              groupId,
            },
          });
        }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - ok;
      const firstErr = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (ok) toast.success(`${ok} task${ok > 1 ? "s" : ""} created`);
      if (failed) toast.error(`${failed} failed${firstErr ? `: ${(firstErr.reason as Error)?.message ?? ""}` : ""}`);
      if (ok) {
        await qc.invalidateQueries({ queryKey: ["task-groups"] });
        await nav({ to: "/groups/$id", params: { id: groupId }, replace: true });
        return;
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
        <div className="mb-6 flex items-center gap-3">
          <Link to="/dashboard">
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">New join task</h1>
        </div>

        <form onSubmit={submit} className="space-y-6">
          <section className="rounded-lg border border-border bg-card p-4 md:p-6">
            <h2 className="mb-4 text-lg font-semibold">Task</h2>
            <div className="space-y-4">
              <div>
                <Label>Task name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <Label>Targets (one per line, @username, t.me/+invite, or t.me/joinchat/invite)</Label>
                <Textarea
                  rows={6}
                  value={targets}
                  onChange={(e) => setTargets(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Min delay (sec)</Label>
                  <Input
                    type="number"
                    value={minDelay}
                    onChange={(e) => setMinDelay(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Max delay (sec)</Label>
                  <Input
                    type="number"
                    value={maxDelay}
                    onChange={(e) => setMaxDelay(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

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
            <div className="space-y-2">
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

          <Button
            type="submit"
            disabled={busy || !selectedIds.length}
            className="w-full"
            size="lg"
          >
            {busy ? "Creating…" : `Create task on ${selectedIds.length || 0} account${selectedIds.length === 1 ? "" : "s"}`}
          </Button>
        </form>
      </div>
    </main>
  );
}
