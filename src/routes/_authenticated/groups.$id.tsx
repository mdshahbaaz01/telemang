import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getGroup,
  getTask,
  processBatchJoin,
  setTaskStatus,
  groupLogs,
} from "@/lib/tasks.functions";
import { Button } from "@/components/ui/button";
import { AdminGate } from "@/components/AdminGate";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/groups/$id")({
  component: () => (
    <AdminGate>
      <GroupRunner />
    </AdminGate>
  ),
});

function GroupRunner() {
  const { id } = Route.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const listFn = useServerFn(getGroup);
  const logsFn = useServerFn(groupLogs);
  const groupQ = useQuery({
    queryKey: ["group", id],
    queryFn: () => listFn({ data: { groupId: id } }),
  });
  const logsQ = useQuery({
    queryKey: ["group-logs", id],
    queryFn: () => logsFn({ data: { groupId: id } }),
    refetchInterval: 3000,
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

  // Per-task counts collected via child callbacks so header totals stay in sync.
  const [taskStats, setTaskStats] = useState<
    Record<string, { total: number; done: number }>
  >({});
  const reportStats = (taskId: string, s: { total: number; done: number }) =>
    setTaskStats((prev) => {
      const cur = prev[taskId];
      if (cur && cur.total === s.total && cur.done === s.done) return prev;
      return { ...prev, [taskId]: s };
    });

  const totals = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const t of tasks) {
      const s = taskStats[t.id];
      if (s) {
        total += s.total;
        done += s.done;
      }
    }
    return { total, done };
  }, [tasks, taskStats]);

  const baseName = ((tasks[0]?.name ?? "Task").split(" · ")[0] ?? "Task").trim();
  const minDelay = tasks[0]?.min_delay ?? 1;
  const maxDelay = tasks[0]?.max_delay ?? 2;
  const allDone = totals.total > 0 && totals.done >= totals.total;
  const groupStatus: "running" | "done" | "idle" = allRunning
    ? "running"
    : allDone
      ? "done"
      : "idle";

  const cancel = () => {
    if (allRunning) stopAll();
    nav({ to: "/dashboard" });
  };

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-[100rem] px-4 py-6 md:px-8">
        <header className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
          <div className="min-w-0">
            <Link
              to="/dashboard"
              className="text-xs text-muted-foreground hover:underline"
            >
              ← Dashboard
            </Link>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
              {baseName}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {totals.done}/{totals.total} done · {tasks.length} account
              {tasks.length === 1 ? "" : "s"} in parallel · delay {minDelay}-
              {maxDelay}s
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <GroupStatusPill status={groupStatus} />
            {allRunning ? (
              <Button variant="outline" onClick={stopAll}>
                Pause
              </Button>
            ) : (
              <Button onClick={startAll} disabled={!tasks.length}>
                Run all in parallel
              </Button>
            )}
            <Button variant="destructive" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </header>

        {groupQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                onStats={reportStats}
              />
            ))}
          </div>
        )}

        <section className="mt-8 rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Live logs</h2>
            <span className="text-xs text-muted-foreground">
              {(logsQ.data ?? []).length} entries
            </span>
          </div>
          <div className="max-h-96 overflow-auto rounded bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {(logsQ.data ?? []).length === 0 ? (
              <div className="text-muted-foreground">No activity yet</div>
            ) : (
              [...(logsQ.data ?? [])].reverse().map((l) => (
                <div
                  key={l.id}
                  className={
                    l.level === "error"
                      ? "text-destructive"
                      : l.level === "warn"
                        ? "text-yellow-500"
                        : l.level === "success"
                          ? "text-green-500"
                          : "text-foreground"
                  }
                >
                  {new Date(l.created_at).toLocaleTimeString()} [{l.level}]
                  {l.account ? (
                    <span className="font-semibold"> {l.account}</span>
                  ) : null}{" "}
                  {l.message}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function GroupStatusPill({
  status,
}: {
  status: "running" | "done" | "idle";
}) {
  const tone =
    status === "running"
      ? "bg-primary text-primary-foreground"
      : status === "done"
        ? "bg-green-500/15 text-green-600 border border-green-500/30"
        : "bg-muted text-muted-foreground border border-border";
  return (
    <span className={`rounded-md px-3 py-1.5 text-sm font-medium ${tone}`}>
      {status === "idle" ? "idle" : status}
    </span>
  );
}

function AccountStatusPill({
  status,
}: {
  status: "running" | "done" | "idle" | "failed";
}) {
  const tone =
    status === "running"
      ? "bg-primary text-primary-foreground"
      : status === "done"
        ? "bg-muted text-foreground border border-border"
        : status === "failed"
          ? "bg-destructive/10 text-destructive border border-destructive/30"
          : "bg-muted text-muted-foreground border border-border";
  return (
    <span
      className={`rounded-md px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  );
}

function TaskColumn({
  taskId,
  accountLabel,
  registerStart,
  registerStop,
  onStats,
}: {
  taskId: string;
  accountLabel: string;
  registerStart: (fn: () => void) => void;
  registerStop: (fn: () => void) => void;
  onStats: (
    taskId: string,
    stats: { total: number; done: number },
  ) => void;
}) {
  const qc = useQueryClient();
  const getT = useServerFn(getTask);
  const runBatch = useServerFn(processBatchJoin);
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
        const r = await runBatch({ data: { taskId, batchSize: 5 } });
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
  const done = joined + requested;

  useEffect(() => {
    onStats(taskId, { total, done });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, total, done]);

  const status: "running" | "done" | "idle" | "failed" = running
    ? "running"
    : total > 0 && pending === 0
      ? failed > 0 && done === 0
        ? "failed"
        : "done"
      : "idle";

  return (
    <article className="flex min-h-[18rem] flex-col rounded-lg border border-border bg-card p-4">
      <header className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="min-w-0 truncate font-semibold">{accountLabel}</div>
        <div className="flex shrink-0 items-center gap-2">
          <AccountStatusPill status={status} />
          {running ? (
            <Button size="sm" variant="outline" onClick={stop}>
              Stop
            </Button>
          ) : null}
        </div>
      </header>
      <div className="mb-2 text-sm text-muted-foreground">
        {done}/{total} processed
        {failed > 0 ? (
          <span className="text-destructive"> · {failed} failed</span>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {items.length === 0 ? (
          <div className="text-muted-foreground">No targets</div>
        ) : (
          items.map((i) => {
            const color =
              i.status === "joined" || i.status === "requested"
                ? "text-green-500"
                : i.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground";
            return (
              <div key={i.id} className={color} title={i.error ?? undefined}>
                [{i.status}] t.me/{i.target}
                {i.status === "failed" && i.error ? ` — ${i.error}` : ""}
              </div>
            );
          })
        )}
      </div>
    </article>
  );
}
