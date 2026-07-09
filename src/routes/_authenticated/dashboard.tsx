import { Loader } from "@/components/ui/loader";
import { FloodWaitBadge } from "@/components/FloodWaitBadge";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  listAccounts,
  startAccountLogin,
  verifyAccountLogin,
  deleteAccount,
} from "@/lib/accounts.functions";
import {
  listTaskGroups,
  getGroupEdit,
  updateGroup,
  deleteGroup,
  resetGroupItems,
  clearTaskHistory,
} from "@/lib/tasks.functions";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { MessageSquare, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { AdminGate } from "@/components/AdminGate";
import { AccountIdPaste } from "@/components/AccountIdPaste";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: () => (
    <AdminGate>
      <Dashboard />
    </AdminGate>
  ),
});

const NAV: string[] = [];

function Dashboard() {
  const qc = useQueryClient();
  const listAcc = useServerFn(listAccounts);
  const listGroupsFn = useServerFn(listTaskGroups);
  const delGroupFn = useServerFn(deleteGroup);
  const resetGroupFn = useServerFn(resetGroupItems);
  const clearHistoryFn = useServerFn(clearTaskHistory);
  const delAcc = useServerFn(deleteAccount);
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const groupsQ = useQuery({
    queryKey: ["task-groups"],
    queryFn: () => listGroupsFn(),
    refetchInterval: 5000,
  });

  const del = useMutation({
    mutationFn: (id: string) => delAcc({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const invalidateGroups = () =>
    qc.invalidateQueries({ queryKey: ["task-groups"] });

  const onDeleteGroup = async (groupId: string, name: string) => {
    if (!confirm(`Delete task "${name}"? This removes it for every account.`))
      return;
    try {
      await delGroupFn({ data: { groupId } });
      toast.success("Task deleted");
      invalidateGroups();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onReset = async (
    groupId: string,
    scope: "failed" | "all",
    name: string,
  ) => {
    try {
      const r = await resetGroupFn({ data: { groupId, scope } });
      toast.success(
        `${name}: ${r.reset} ${scope === "failed" ? "failed" : ""} item${r.reset === 1 ? "" : "s"} queued`,
      );
      invalidateGroups();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const soon = () => toast.info("Coming soon");

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 pt-6 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">TeleManager Pro</h1>
        <Link to="/tasks/new">
          <Button size="sm" disabled={!accountsQ.data?.length}>
            <Plus className="mr-1 h-4 w-4" /> New Task
          </Button>
        </Link>
      </div>

      <div className="mx-auto max-w-7xl space-y-10 px-4 py-8 md:px-8">
        <section>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                Shared accounts ({accountsQ.data?.length ?? 0})
              </h2>
              <p className="text-sm text-muted-foreground">
                Every admin sees and can use every account added here.
              </p>
            </div>
            <AddAccountDialog onDone={() => qc.invalidateQueries({ queryKey: ["accounts"] })} />
          </div>

          {accountsQ.isLoading ? (
            <Loader size="sm" />
          ) : accountsQ.data?.length ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {accountsQ.data.map((a) => {
                const paused =
                  a.paused_until && new Date(a.paused_until) > new Date();
                const label = paused ? "paused" : a.status;
                return (
                  <article
                    key={a.id}
                    className="rounded-lg border border-border bg-card p-4"
                  >
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-semibold">
                          {a.first_name || a.username || a.phone}
                        </div>
                        <div className="text-xs text-muted-foreground">{a.phone}</div>
                      </div>
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                        {label}
                      </span>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div>
                        <span className="font-medium text-foreground/70">Added by:</span>{" "}
                        {email || "—"}
                      </div>
                      <div>
                        <span className="font-medium text-foreground/70">Last used:</span>{" "}
                        {email || "—"} ·{" "}
                        {new Date(a.updated_at ?? a.created_at).toLocaleString()}
                      </div>
                      <FloodWaitBadge pausedUntil={a.paused_until} lastError={a.last_error} />
                    </div>
                    <div className="mt-4 flex gap-2">
                      <Button variant="secondary" size="sm" asChild>
                        <Link to="/accounts/$id" params={{ id: a.id }}>
                          <MessageSquare className="mr-1 h-3.5 w-3.5" /> Open
                        </Link>
                      </Button>
                      <Button variant="outline" size="sm" onClick={soon}>
                        <RefreshCw className="mr-1 h-3.5 w-3.5" /> Check
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => del.mutate(a.id)}
                        disabled={del.isPending}
                        aria-label="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No accounts yet. Add one with your phone, api_id, and api_hash from my.telegram.org.
            </p>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-semibold tracking-tight">Recent tasks</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={invalidateGroups}
                aria-label="Refresh"
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!confirm("Clear all task history? Running tasks are kept.")) return;
                  try {
                    const res = await clearHistoryFn();
                    toast.success(`Cleared ${res.deleted} task${res.deleted === 1 ? "" : "s"}`);
                    invalidateGroups();
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}
                disabled={!groupsQ.data?.length}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear history
              </Button>
            </div>
          </div>
          {groupsQ.isLoading ? (
            <Loader size="sm" />
          ) : groupsQ.data?.length ? (
            <ul className="space-y-3">
              {groupsQ.data.map((g) => (
                <li
                  key={g.groupId}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      to="/groups/$id"
                      params={{ id: g.groupId }}
                      className="min-w-0 flex-1"
                    >
                      <div className="truncate text-base font-semibold hover:underline">
                        {g.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(g.createdAt).toLocaleString()} · delay {g.minDelay}-{g.maxDelay}s
                        {" · "}{g.accounts} account{g.accounts === 1 ? "" : "s"}
                        {g.total > 0 ? ` · ${g.done}/${g.total} done` : ""}
                        {g.failed > 0 ? ` · ${g.failed} failed` : ""}
                      </div>
                    </Link>
                    <StatusPill status={g.status} />
                    <EditGroupDialog
                      groupId={g.groupId}
                      onSaved={invalidateGroups}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onReset(g.groupId, "failed", g.name)}
                      disabled={g.failed === 0}
                    >
                      <RotateCcw className="mr-1 h-3.5 w-3.5" /> Retry failed
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onReset(g.groupId, "all", g.name)}
                      disabled={g.total === 0}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" /> Re-run all
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => onDeleteGroup(g.groupId, g.name)}
                      aria-label="Delete task"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}

function StatusPill({
  status,
}: {
  status: "running" | "done" | "failed" | "idle" | "partial";
}) {
  const tone =
    status === "running"
      ? "bg-primary/10 text-primary border-primary/30"
      : status === "done"
        ? "bg-green-500/10 text-green-600 border-green-500/30"
        : status === "failed"
          ? "bg-destructive/10 text-destructive border-destructive/30"
          : status === "partial"
            ? "bg-yellow-500/10 text-yellow-600 border-yellow-500/30"
            : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  );
}

function EditGroupDialog({
  groupId,
  onSaved,
}: {
  groupId: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const loadEdit = useServerFn(getGroupEdit);
  const listAcc = useServerFn(listAccounts);
  const save = useServerFn(updateGroup);

  const editQ = useQuery({
    queryKey: ["group-edit", groupId],
    queryFn: () => loadEdit({ data: { groupId } }),
    enabled: open,
  });
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => listAcc(),
    enabled: open,
  });

  const [name, setName] = useState("");
  const [minDelay, setMinDelay] = useState("1");
  const [maxDelay, setMaxDelay] = useState("2");
  const [targets, setTargets] = useState<string[]>([]);
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [newLinks, setNewLinks] = useState("");
  const [accountIds, setAccountIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && editQ.data) {
      setName(editQ.data.name);
      setMinDelay(String(editQ.data.minDelay));
      setMaxDelay(String(editQ.data.maxDelay));
      setTargets(editQ.data.targets);
      setAccountIds(new Set(editQ.data.accountIds));
      setNewLinks("");
    }
  }, [open, editQ.data]);

  const removeTarget = (t: string) =>
    setTargets((prev) => prev.filter((x) => x !== t));

  const startEditTarget = (t: string) => {
    setEditingTarget(t);
    setEditingValue(t);
  };
  const cancelEditTarget = () => {
    setEditingTarget(null);
    setEditingValue("");
  };
  const commitEditTarget = () => {
    if (editingTarget == null) return;
    const cleaned = editingValue
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^t\.me\//i, "")
      .replace(/^@/, "")
      .replace(/\/+$/, "");
    if (!cleaned) {
      cancelEditTarget();
      return;
    }
    setTargets((prev) => {
      const next = prev.map((x) => (x === editingTarget ? cleaned : x));
      // de-dupe while preserving order
      return Array.from(new Set(next));
    });
    cancelEditTarget();
  };

  const addNewLinks = () => {
    const cleaned = newLinks
      .split(/\r?\n|,|\s/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) =>
        s
          .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, "")
          .replace(/[?#].*$/, "")
          .replace(/^@/, ""),
      );
    if (!cleaned.length) return;
    setTargets((prev) => Array.from(new Set([...prev, ...cleaned])));
    setNewLinks("");
  };

  const toggleAccount = (id: string) => {
    setAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!name.trim()) return toast.error("Name is required");
    if (accountIds.size === 0) return toast.error("Pick at least one account");
    setBusy(true);
    try {
      await save({
        data: {
          groupId,
          name: name.trim(),
          minDelay: Number(minDelay),
          maxDelay: Number(maxDelay),
          targets,
          accountIds: [...accountIds],
        },
      });
      toast.success("Task updated");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const originalIds = new Set(editQ.data?.accountIds ?? []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
        </DialogHeader>
        {editQ.isLoading || !editQ.data ? (
          <Loader size="sm" />
        ) : (
          <div className="space-y-5">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
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

            <div>
              <Label>Links ({targets.length})</Label>
              <div className="mt-1 max-h-56 space-y-1 overflow-auto rounded-md border border-border p-2">
                {targets.length === 0 && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    No links.
                  </p>
                )}
                {targets.map((t) => {
                  const isEditing = editingTarget === t;
                  return (
                    <div
                      key={t}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      {isEditing ? (
                        <>
                          <span className="text-muted-foreground">t.me/</span>
                          <Input
                            autoFocus
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEditTarget();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEditTarget();
                              }
                            }}
                            className="h-7 flex-1 text-sm"
                          />
                          <button
                            type="button"
                            onClick={commitEditTarget}
                            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditTarget}
                            className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="flex-1 truncate">t.me/{t}</span>
                          <button
                            type="button"
                            onClick={() => startEditTarget(t)}
                            className="text-muted-foreground hover:text-primary"
                            aria-label="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeTarget(t)}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label="Remove"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <Textarea
                className="mt-2"
                rows={3}
                value={newLinks}
                onChange={(e) => setNewLinks(e.target.value)}
                onBlur={addNewLinks}
                placeholder="Add new links, one per line"
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <Label>Accounts ({accountsQ.data?.length ?? 0})</Label>
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-0.5 hover:bg-accent"
                    onClick={() =>
                      setAccountIds(
                        new Set((accountsQ.data ?? []).map((a) => a.id)),
                      )
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-0.5 hover:bg-accent"
                    onClick={() => setAccountIds(new Set())}
                  >
                    Deselect all
                  </button>
                </div>
              </div>
              <AccountIdPaste
                accounts={accountsQ.data ?? []}
                onSelect={(ids) =>
                  setAccountIds((prev) => {
                    const next = new Set(prev);
                    for (const id of ids) next.add(id);
                    return next;
                  })
                }
                className="mb-2"
              />
              <div className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-2">
                {(accountsQ.data ?? []).map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <Checkbox
                      checked={accountIds.has(a.id)}
                      onCheckedChange={() => toggleAccount(a.id)}
                    />
                    <span className="flex-1 truncate font-medium">
                      {a.first_name || a.username || a.phone}
                    </span>
                    {originalIds.has(a.id) && (
                      <span className="text-xs text-muted-foreground">
                        in task
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>

            <Button
              className="w-full"
              size="lg"
              onClick={submit}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddAccountDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"start" | "code" | "2fa">("start");
  const [phone, setPhone] = useState("");
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = useServerFn(startAccountLogin);
  const verify = useServerFn(verifyAccountLogin);

  const reset = () => {
    setPhase("start");
    setPhone("");
    setApiId("");
    setApiHash("");
    setCode("");
    setPassword("");
    setAttemptId(null);
  };

  const onStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await start({
        data: { phone, apiId: Number(apiId), apiHash },
      });
      setAttemptId(r.attemptId);
      setPhase("code");
      toast.success("Code sent");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attemptId) return;
    setBusy(true);
    try {
      const r = await verify({
        data: {
          attemptId,
          code,
          password: password || undefined,
        },
      });
      if ("needs2FA" in r && r.needs2FA) {
        setPhase("2fa");
        toast.info("Enter your 2FA password");
      } else {
        toast.success("Account added");
        setOpen(false);
        reset();
        onDone();
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" /> Add Account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Telegram account</DialogTitle>
        </DialogHeader>
        {phase === "start" && (
          <form onSubmit={onStart} className="space-y-3">
            <div>
              <Label>Phone (with country code)</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91XXXXXXXXXX" required />
            </div>
            <div>
              <Label>api_id</Label>
              <Input value={apiId} onChange={(e) => setApiId(e.target.value)} required />
            </div>
            <div>
              <Label>api_hash</Label>
              <Input value={apiHash} onChange={(e) => setApiHash(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Sending code…" : "Send code"}
            </Button>
          </form>
        )}
        {phase === "code" && (
          <form onSubmit={onVerify} className="space-y-3">
            <Label>Code from Telegram</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} required />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Verifying…" : "Verify"}
            </Button>
          </form>
        )}
        {phase === "2fa" && (
          <form onSubmit={onVerify} className="space-y-3">
            <Label>2FA password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Verifying…" : "Sign in"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// NewTaskDialog moved to route /tasks/new