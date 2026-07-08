import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getGroup,
  getTask,
  processNextJoin,
  setTaskStatus,
} from "@/lib/tasks.functions";
import { Button } from "@/components/ui/button";
import { AdminGate } from "@/components/AdminGate";
import { ArrowLeft, Play, Square } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/groups/")({
  component: () => (
    <AdminGate>
      <GroupRunner />
    </AdminGate>
  ),
});

function GroupRunner() {
  const { id } = Route.useParams();
  const listFn = useServerFn(getGroup);
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
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function TaskColumn({
  taskId,
  accountLabel,
  registerStart,
  registerStop,
}: {
  taskId: string;
  accountLabel: string;
  registerStart: (fn: () => void) => void;
  registerStop: (fn: () => void) => void;
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
          {running ? (
            <Button size="sm" variant="destructive" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={loop} disabled={pending === 0}>
              Run
            </Button>
          )}
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
