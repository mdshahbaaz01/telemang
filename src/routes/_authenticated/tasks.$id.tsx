import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getTask,
  processNextJoin,
  recentLogs,
  setTaskStatus,
} from "@/lib/tasks.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AdminGate } from "@/components/AdminGate";

export const Route = createFileRoute("/_authenticated/tasks/$id")({
  component: () => (
    <AdminGate>
      <TaskDetail />
    </AdminGate>
  ),
});

type LogRow = {
  id: string;
  level: string;
  message: string;
  created_at: string;
};

function TaskDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const getT = useServerFn(getTask);
  const runNext = useServerFn(processNextJoin);
  const setStatus = useServerFn(setTaskStatus);
  const getLogs = useServerFn(recentLogs);

  const taskQ = useQuery({ queryKey: ["task", id], queryFn: () => getT({ data: { id } }) });
  const logsQ = useQuery({
    queryKey: ["logs", id],
    queryFn: () => getLogs({ data: { taskId: id } }),
  });

  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    const ch = supabase
      .channel(`logs-${id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "task_logs", filter: `task_id=eq.${id}` },
        () => qc.invalidateQueries({ queryKey: ["logs", id] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "join_task_items", filter: `task_id=eq.${id}` },
        () => qc.invalidateQueries({ queryKey: ["task", id] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [id, qc]);

  const loop = async () => {
    if (running) return;
    cancelRef.current = false;
    setRunning(true);
    await setStatus({ data: { id, status: "running" } });
    try {
      while (!cancelRef.current) {
        const r = await runNext({ data: { taskId: id } });
        qc.invalidateQueries({ queryKey: ["task", id] });
        if (r.done) {
          toast.success("All targets processed");
          break;
        }
        if (r.paused) {
          toast.warning(r.message ?? "Paused");
          break;
        }
        const min = taskQ.data?.task?.min_delay ?? 15;
        const max = taskQ.data?.task?.max_delay ?? 45;
        const wait = (min + Math.random() * (max - min)) * 1000;
        await new Promise((res) => setTimeout(res, wait));
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRunning(false);
      await setStatus({ data: { id, status: "paused" } });
      qc.invalidateQueries({ queryKey: ["task", id] });
    }
  };

  const stop = () => {
    cancelRef.current = true;
  };

  const task = taskQ.data?.task;
  const items = taskQ.data?.items ?? [];
  const pending = items.filter((i) => i.status === "pending").length;
  const joined = items.filter((i) => i.status === "joined").length;
  const requested = items.filter((i) => i.status === "requested").length;
  const failed = items.filter((i) => i.status === "failed").length;

  return (
    <main className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/dashboard" className="text-xs text-muted-foreground underline">
              ← Dashboard
            </Link>
            <h1 className="text-xl font-semibold">{task?.name ?? "Task"}</h1>
            <p className="text-xs text-muted-foreground">
              status: {task?.status} · {joined} joined · {requested} requested · {failed} failed · {pending} pending
            </p>
          </div>
          <div className="flex gap-2">
            {running ? (
              <Button variant="destructive" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button onClick={loop} disabled={!task || pending === 0}>
                Run
              </Button>
            )}
          </div>
        </div>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Live logs</h2>
          <div className="max-h-96 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs">
            {(logsQ.data ?? []).length === 0 ? (
              <div className="text-muted-foreground">No activity yet</div>
            ) : (
              (logsQ.data as LogRow[]).map((l) => (
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
                  [{new Date(l.created_at).toLocaleTimeString()}] {l.message}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Targets</h2>
          <ul className="max-h-72 space-y-1 overflow-auto text-sm">
            {items.map((i) => (
              <li key={i.id} className="flex items-center justify-between border-b border-border/50 py-1">
                <span>@{i.target}</span>
                <span
                  className={
                    i.status === "joined" || i.status === "requested"
                      ? "text-xs text-green-500"
                      : i.status === "failed"
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                  }
                >
                  {i.status}
                  {i.error ? ` · ${i.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}