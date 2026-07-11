import { Loader } from "@/components/ui/loader";
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

// Simple fleet-wide state shared across TaskColumn instances.
type FleetCtx = {
  acquire: () => Promise<() => void>; // returns release()
  autoResume: boolean;
};

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

  // Fleet settings (persisted in localStorage)
  const [maxParallel, setMaxParallel] = useState<number>(() => {
    if (typeof window === "undefined") return 5;
    const v = Number(window.localStorage.getItem("fleet.maxParallelJoins") || 5);
    return Number.isFinite(v) && v >= 1 ? v : 5;
  });
  const [autoResume, setAutoResume] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("fleet.autoResume") !== "0";
  });
  useEffect(() => {
    window.localStorage.setItem("fleet.maxParallelJoins", String(maxParallel));
  }, [maxParallel]);
  useEffect(() => {
    window.localStorage.setItem("fleet.autoResume", autoResume ? "1" : "0");
  }, [autoResume]);

  // Semaphore that caps concurrent active task loops fleet-wide.
  const semRef = useRef<{
    limit: number;
    active: number;
    queue: Array<() => void>;
  }>({ limit: maxParallel, active: 0, queue: [] });
  useEffect(() => {
    semRef.current.limit = maxParallel;
    // Wake queued waiters if the limit grew.
    while (
      semRef.current.active < semRef.current.limit &&
      semRef.current.queue.length
    ) {
      const next = semRef.current.queue.shift();
      if (next) {
        semRef.current.active++;
        next();
      }
    }
  }, [maxParallel]);
  const fleetCtx = useMemo<FleetCtx>(
    () => ({
      autoResume,
      acquire: () =>
        new Promise((resolve) => {
          const sem = semRef.current;
          const grant = () =>
            resolve(() => {
              sem.active = Math.max(0, sem.active - 1);
              const next = sem.queue.shift();
              if (next) {
                sem.active++;
                next();
              }
            });
          if (sem.active < sem.limit) {
            sem.active++;
            grant();
          } else {
            sem.queue.push(grant);
          }
        }),
    }),
    [autoResume],
  );

  const startAll = () => {
    setAllRunning(true);
    startAllRef.current.forEach((fn) => fn());
  };
  const stopAll = () => {
    setAllRunning(false);
    // Drain queued waiters so nothing kicks in after Pause.
    semRef.current.queue.length = 0;
    semRef.current.active = 0;
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

        <section className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Max parallel accounts</span>
            <input
              type="number"
              min={1}
              max={100}
              value={maxParallel}
              onChange={(e) =>
                setMaxParallel(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
              }
              className="h-8 w-20 rounded border border-border bg-background px-2"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoResume}
              onChange={(e) => setAutoResume(e.target.checked)}
            />
            <span>Auto-resume after FloodWait</span>
          </label>
          <span className="ml-auto text-xs text-muted-foreground">
            Running now: {Math.min(semRef.current.active, tasks.length)} · queued:{" "}
            {semRef.current.queue.length}
          </span>
        </section>

        {groupQ.isLoading ? (
          <Loader size="sm" />
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
                fleet={fleetCtx}
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
  fleet,
}: {
  taskId: string;
  accountLabel: string;
  registerStart: (fn: () => void) => void;
  registerStop: (fn: () => void) => void;
  onStats: (
    taskId: string,
    stats: { total: number; done: number },
  ) => void;
  fleet: FleetCtx;
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
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [waitingSlot, setWaitingSlot] = useState(false);
  const [floodUntil, setFloodUntil] = useState<number | null>(null);

  const loop = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = false;
    setRunning(true);
    setWaitingSlot(true);
    const release = await fleet.acquire();
    setWaitingSlot(false);
    if (cancelRef.current) {
      release();
      runningRef.current = false;
      setRunning(false);
      return;
    }
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
          const secs = (r as { seconds?: number }).seconds;
          const untilIso = (r as { pausedUntil?: string }).pausedUntil;
          const target = (r as { target?: string }).target;
          if (fleet.autoResume && secs && secs > 0) {
            const untilTs = untilIso ? new Date(untilIso).getTime() : Date.now() + secs * 1000;
            setFloodUntil(untilTs);
            toast.warning(
              `${accountLabel}: FloodWait ${secs}s${target ? ` on @${target}` : ""} — auto-resume scheduled`,
            );
            const delay = Math.max(1000, untilTs - Date.now() + 500);
            resumeTimerRef.current = setTimeout(() => {
              resumeTimerRef.current = null;
              setFloodUntil(null);
              loop();
            }, delay);
          } else {
            toast.warning(`${accountLabel}: ${r.message ?? "paused"}`);
          }
          break;
        }
        const min = taskQ.data?.task?.min_delay ?? 1;
        const max = taskQ.data?.task?.max_delay ?? 2;
        const wait = (min + Math.random() * (max - min)) * 1000;
        await new Promise((res) => setTimeout(res, wait));
      }
    } catch (err) {
      toast.error(`${accountLabel}: ${(err as Error).message}`);
    } finally {
      release();
      runningRef.current = false;
      setRunning(false);
      await setStatus({ data: { id: taskId, status: "paused" } }).catch(() => {});
      qc.invalidateQueries({ queryKey: ["task", taskId] });
    }
  };
  const stop = () => {
    cancelRef.current = true;
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
      setFloodUntil(null);
    }
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

  // Live countdown when parked for FloodWait auto-resume.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!floodUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [floodUntil]);
  const secsLeft = floodUntil ? Math.max(0, Math.ceil((floodUntil - now) / 1000)) : 0;

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
      {waitingSlot ? (
        <div className="mb-2 text-xs text-muted-foreground">Waiting for a free slot…</div>
      ) : null}
      {floodUntil ? (
        <div className="mb-2 text-xs text-yellow-500">
          FloodWait — auto-resume in {secsLeft}s
        </div>
      ) : null}
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
