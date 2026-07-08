import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getGroup,
  getTask,
  processNextJoin,
  setTaskStatus,
  addAccountsToGroup,
  deleteJoinTask,
} from "@/lib/tasks.functions";
import { listAccounts } from "@/lib/accounts.functions";
import { Button } from "@/components/ui/button";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, Play, Square, Users2, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/groups/$id")({
  component: () => (
    <AdminGate>
      <GroupRunner />
    </AdminGate>
  ),
});

function GroupRunner() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const listFn = useServerFn(getGroup);
  const delTask = useServerFn(deleteJoinTask);
  const groupQ = useQuery({
    queryKey: ["group", id],
    queryFn: () => listFn({ data: { groupId: id } }),
  });

  const [allRunning, setAllRunning] = useState(false);
  const runAllRef = useRef<Map<string, () => void>>(new Map());
  const startAllRef = useRef<Map<string, () => void>>(new Map());

  const startAll = () => {
    setAllRunning(true);
    startAllRef.current.forEach((fn) => fn());
  };
  const stopAll = () => {
    setAllRunning(false);
    runAllRef.current.forEach((fn) => fn());
  };

  const tasks = groupQ.data ?? [];
  const removeAccount = async (taskId: string, label: string) => {
    if (!confirm(`Remove ${label} from this group?`)) return;
    try {
      await delTask({ data: { id: taskId } });
      toast.success(`${label} removed`);
      qc.invalidateQueries({ queryKey: ["group", id] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-[100rem] px-4 py-6 md:px-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/dashboard">
              <Button variant="ghost" size="icon" aria-label="Back">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Parallel run</h1>
              <p className="text-sm text-muted-foreground">
                {tasks.length} account{tasks.length === 1 ? "" : "s"} running side-by-side
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <EditAccountsDialog
              groupId={id}
              existingIds={tasks.map((t) => t.account_id)}
              onDone={() => qc.invalidateQueries({ queryKey: ["group", id] })}
            />
            <Button onClick={startAll} disabled={allRunning || !tasks.length}>
              <Play className="mr-1 h-4 w-4" /> Start all
            </Button>
            <Button variant="destructive" onClick={stopAll} disabled={!allRunning}>
              <Square className="mr-1 h-4 w-4" /> Stop all
            </Button>
          </div>
        </div>

        {groupQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {tasks.map((t) => (
              <TaskColumn
                key={t.id}
                taskId={t.id}
                accountLabel={
                  t.telegram_accounts?.first_name ||
                  t.telegram_accounts?.username ||
                  t.telegram_accounts?.phone ||
                  "account"
                }
                registerStart={(fn) => startAllRef.current.set(t.id, fn)}
                registerStop={(fn) => runAllRef.current.set(t.id, fn)}
                onRemove={(label) => removeAccount(t.id, label)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function EditAccountsDialog({
  groupId,
  existingIds,
  onDone,
}: {
  groupId: string;
  existingIds: string[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const listAcc = useServerFn(listAccounts);
  const addAcc = useServerFn(addAccountsToGroup);
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => listAcc(),
    enabled: open,
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const existing = useMemo(() => new Set(existingIds), [existingIds]);
  const candidates = (accountsQ.data ?? []).filter((a) => !existing.has(a.id));

  const toggle = (accId: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(accId)) next.delete(accId);
      else next.add(accId);
      return next;
    });
  };

  const submit = async () => {
    if (!picked.size) return toast.error("Pick at least one account");
    setBusy(true);
    try {
      const r = await addAcc({
        data: { groupId, accountIds: [...picked] },
      });
      toast.success(`${r.added} account${r.added === 1 ? "" : "s"} added`);
      onDone();
      setOpen(false);
      setPicked(new Set());
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Users2 className="mr-1 h-4 w-4" /> Edit accounts
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add accounts to this group</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          New accounts inherit the group's targets. Remove existing accounts from
          their column.
        </p>
        <div className="max-h-72 space-y-1 overflow-auto">
          {candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No other accounts available.
            </p>
          )}
          {candidates.map((a) => (
            <label
              key={a.id}
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 hover:bg-accent"
            >
              <Checkbox
                checked={picked.has(a.id)}
                onCheckedChange={() => toggle(a.id)}
              />
              <span className="text-sm font-medium">
                {a.first_name || a.username || a.phone}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {a.phone}
              </span>
            </label>
          ))}
        </div>
        <Button onClick={submit} disabled={busy || !picked.size}>
          {busy ? "Adding…" : `Add ${picked.size} account${picked.size === 1 ? "" : "s"}`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function TaskColumn({
  taskId,
  accountLabel,
  registerStart,
  registerStop,
  onRemove,
}: {
  taskId: string;
  accountLabel: string;
  registerStart: (fn: () => void) => void;
  registerStop: (fn: () => void) => void;
  onRemove: (label: string) => void;
}) {
  const qc = useQueryClient();
  const getT = useServerFn(getTask);
  const runNext = useServerFn(processNextJoin);
  const setStatus = useServerFn(setTaskStatus);

  const taskQ = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => getT({ data: { id: taskId } }),
  });

  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  const runningRef = useRef(false);

  const loop = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = false;
    setRunning(true);
    await setStatus({ data: { id: taskId, status: "running" } }).catch(() => {});
    try {
      while (!cancelRef.current) {
        const r = await runNext({ data: { taskId } });
        qc.invalidateQueries({ queryKey: ["task", taskId] });
        if (r.done) {
          toast.success(`${accountLabel}: done`);
          break;
        }
        if (r.paused) {
          toast.warning(`${accountLabel}: ${r.message ?? "paused"}`);
          break;
        }
        const min = taskQ.data?.task?.min_delay ?? 15;
        const max = taskQ.data?.task?.max_delay ?? 45;
        const wait = (min + Math.random() * (max - min)) * 1000;
        await new Promise((res) => setTimeout(res, wait));
      }
    } catch (err) {
      toast.error(`${accountLabel}: ${(err as Error).message}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      await setStatus({ data: { id: taskId, status: "paused" } }).catch(() => {});
      qc.invalidateQueries({ queryKey: ["task", taskId] });
    }
  };
  const stop = () => {
    cancelRef.current = true;
  };

  useEffect(() => {
    registerStart(() => {
      loop();
    });
    registerStop(() => {
      stop();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    const ch = supabase
      .channel(`col-${taskId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "join_task_items",
          filter: `task_id=eq.${taskId}`,
        },
        () => qc.invalidateQueries({ queryKey: ["task", taskId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [taskId, qc]);

  const items = taskQ.data?.items ?? [];
  const total = items.length;
  const joined = items.filter((i) => i.status === "joined").length;
  const requested = items.filter((i) => i.status === "requested").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const pending = items.filter((i) => i.status === "pending").length;
  const current = items.find((i) => i.status === "pending");

  return (
    <article className="flex h-[32rem] flex-col rounded-lg border border-border bg-card">
      <header className="border-b border-border p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="truncate font-semibold">{accountLabel}</div>
          <div className="flex items-center gap-1">
            {running ? (
              <Button size="sm" variant="destructive" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button size="sm" onClick={loop} disabled={pending === 0}>
                Run
              </Button>
            )}
            <button
              type="button"
              onClick={() => onRemove(accountLabel)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
              aria-label="Remove account from group"
              title="Remove account from group"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {joined}/{total} joined · {requested} requested · {failed} failed · {pending} pending
        </div>
        {current && (
          <div className="mt-1 truncate text-xs">
            <span className="text-muted-foreground">next:</span> @{current.target}
          </div>
        )}
      </header>
      <div className="flex-1 overflow-auto p-2 text-xs">
        {items.length === 0 ? (
          <div className="text-muted-foreground">No targets</div>
        ) : (
          items.map((i) => (
            <div
              key={i.id}
              className="flex items-center justify-between border-b border-border/40 py-1"
            >
              <span className="truncate">@{i.target}</span>
              <span
                className={
                  i.status === "joined" || i.status === "requested"
                    ? "text-green-500"
                    : i.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }
              >
                {i.status}
              </span>
            </div>
          ))
        )}
      </div>
    </article>
  );
}
