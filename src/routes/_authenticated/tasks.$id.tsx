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
  addTaskItems,
  deleteTaskItem,
  parseTargets,
} from "@/lib/tasks.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { AdminGate } from "@/components/AdminGate";
import { Trash2, RotateCw } from "lucide-react";
import { cloneJoinTask } from "@/lib/clone.functions";
import { useNavigate } from "@tanstack/react-router";
import { VirtualList } from "@/components/VirtualList";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/tasks/$id")({
  beforeLoad: requireAdminBeforeLoad,
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
  const nav = useNavigate();
  const qc = useQueryClient();
  const getT = useServerFn(getTask);
  const runNext = useServerFn(processNextJoin);
  const setStatus = useServerFn(setTaskStatus);
  const getLogs = useServerFn(recentLogs);
  const addItems = useServerFn(addTaskItems);
  const delItem = useServerFn(deleteTaskItem);
  const cloneFn = useServerFn(cloneJoinTask);
  const [cloning, setCloning] = useState(false);

  const runAgain = async () => {
    setCloning(true);
    try {
      const r = await cloneFn({ data: { sourceTaskId: id } });
      toast.success("Cloned — opening new task");
      nav({ to: "/tasks/$id", params: { id: r.taskId } });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCloning(false);
    }
  };

  const [newLinks, setNewLinks] = useState("");
  const [busyEdit, setBusyEdit] = useState(false);

  const addLinks = async () => {
    const parsed = parseTargets(newLinks);
    if (!parsed.length) return toast.error("Add at least one link");
    setBusyEdit(true);
    try {
      const r = await addItems({ data: { taskId: id, targets: parsed } });
      toast.success(`${r.added} link${r.added === 1 ? "" : "s"} added`);
      setNewLinks("");
      qc.invalidateQueries({ queryKey: ["task", id] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyEdit(false);
    }
  };

  const removeItem = async (itemId: string) => {
    try {
      await delItem({ data: { itemId } });
      qc.invalidateQueries({ queryKey: ["task", id] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

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
        const min = taskQ.data?.task?.min_delay ?? 1;
        const max = taskQ.data?.task?.max_delay ?? 2;
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
            <Button variant="outline" onClick={runAgain} disabled={cloning || !task}>
              <RotateCw className="h-3.5 w-3.5" /> Run again
            </Button>
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
          <VirtualList<LogRow>
            items={(logsQ.data ?? []) as LogRow[]}
            estimateSize={20}
            className="h-96 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs"
            emptyState={<div className="text-muted-foreground">No activity yet</div>}
            getKey={(l) => l.id}
            renderItem={(l) => (
              <div
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
            )}
          />
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Targets</h2>
          <div className="mb-3 space-y-2 rounded-md border border-dashed border-border p-3">
            <Textarea
              rows={3}
              value={newLinks}
              onChange={(e) => setNewLinks(e.target.value)}
              placeholder="@username, t.me/+invite, one per line…"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={addLinks} disabled={busyEdit}>
                {busyEdit ? "Adding…" : "Add links"}
              </Button>
            </div>
          </div>
          <VirtualList
            items={items}
            estimateSize={32}
            className="h-72 overflow-auto text-sm"
            emptyState={<div className="text-muted-foreground text-xs">No targets yet</div>}
            getKey={(i) => i.id}
            renderItem={(i) => (
              <div className="flex items-center justify-between border-b border-border/50 py-1">
                <span>@{i.target}</span>
                <div className="flex items-center gap-2">
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
                  <button
                    type="button"
                    onClick={() => removeItem(i.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          />
        </section>
      </div>
    </main>
  );
}