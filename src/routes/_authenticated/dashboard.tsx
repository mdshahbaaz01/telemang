import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
import { listTasks } from "@/lib/tasks.functions";
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
import { LogOut, Plus, RefreshCw, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

const NAV = [
  "Owner Panel",
  "Cleanup",
  "Broadcast",
  "Bot Flow",
  "Reactions",
  "Poll Vote",
  "Leave Channels",
];

function Dashboard() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const listAcc = useServerFn(listAccounts);
  const listTsk = useServerFn(listTasks);
  const delAcc = useServerFn(deleteAccount);
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const tasksQ = useQuery({ queryKey: ["tasks"], queryFn: () => listTsk() });

  const signOut = async () => {
    await supabase.auth.signOut();
    nav({ to: "/auth" });
  };

  const del = useMutation({
    mutationFn: (id: string) => delAcc({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const soon = () => toast.info("Coming soon");

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 md:px-8">
          <h1 className="mr-auto text-xl font-semibold tracking-tight">TeleManager Pro</h1>
          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((n) => (
              <Button key={n} variant="ghost" size="sm" onClick={soon}>
                {n}
              </Button>
            ))}
            <Link to="/tasks/new">
              <Button size="sm" disabled={!accountsQ.data?.length}>
                New Task
              </Button>
            </Link>
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </nav>
        </div>
      </header>

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
            <p className="text-sm text-muted-foreground">Loading…</p>
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
                      {a.last_error ? (
                        <div className="text-destructive">{a.last_error}</div>
                      ) : null}
                    </div>
                    <div className="mt-4 flex gap-2">
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
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">Join Tasks</h2>
          {tasksQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tasksQ.data?.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {tasksQ.data.map((t) => (
                <li key={t.id} className="flex items-center justify-between p-4">
                  <div>
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.status} · {new Date(t.created_at).toLocaleString()}
                    </div>
                  </div>
                  <Link
                    to="/tasks/$id"
                    params={{ id: t.id }}
                    className="text-sm text-primary underline"
                  >
                    Open
                  </Link>
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

type AccountRow = {
  id: string;
  phone: string;
  username: string | null;
  first_name: string | null;
};

// NewTaskDialog moved to route /tasks/new