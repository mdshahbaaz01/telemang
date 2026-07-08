import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  listAccounts,
  startAccountLogin,
  verifyAccountLogin,
  deleteAccount,
} from "@/lib/accounts.functions";
import { listTasks, createJoinTask, parseTargets } from "@/lib/tasks.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const listAcc = useServerFn(listAccounts);
  const listTsk = useServerFn(listTasks);
  const delAcc = useServerFn(deleteAccount);

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

  return (
    <main className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">TeleManager Pro</h1>
            <p className="text-sm text-muted-foreground">Manage Telegram accounts and join tasks</p>
          </div>
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </header>

        <section className="rounded-lg border border-border bg-card p-4 md:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Accounts</h2>
            <AddAccountDialog onDone={() => qc.invalidateQueries({ queryKey: ["accounts"] })} />
          </div>
          {accountsQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : accountsQ.data?.length ? (
            <ul className="divide-y divide-border">
              {accountsQ.data.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="font-medium">
                      {a.first_name || a.username || a.phone}{" "}
                      <span className="text-xs text-muted-foreground">{a.phone}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {a.status}
                      {a.paused_until ? ` · paused until ${new Date(a.paused_until).toLocaleTimeString()}` : ""}
                      {a.last_error ? ` · ${a.last_error}` : ""}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => del.mutate(a.id)}
                    disabled={del.isPending}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No accounts yet. Add one with your phone, api_id, and api_hash from my.telegram.org.
            </p>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-4 md:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Join Tasks</h2>
            <NewTaskDialog
              accounts={accountsQ.data ?? []}
              onDone={() => qc.invalidateQueries({ queryKey: ["tasks"] })}
            />
          </div>
          {tasksQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tasksQ.data?.length ? (
            <ul className="divide-y divide-border">
              {tasksQ.data.map((t) => (
                <li key={t.id} className="flex items-center justify-between py-3">
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
        <Button size="sm">Add account</Button>
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

function NewTaskDialog({
  accounts,
  onDone,
}: {
  accounts: AccountRow[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [targets, setTargets] = useState("");
  const [minDelay, setMinDelay] = useState("15");
  const [maxDelay, setMaxDelay] = useState("45");
  const [busy, setBusy] = useState(false);
  const create = useServerFn(createJoinTask);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseTargets(targets);
    if (!parsed.length) return toast.error("Add at least one target");
    setBusy(true);
    try {
      await create({
        data: {
          accountId,
          name,
          targets: parsed,
          minDelay: Number(minDelay),
          maxDelay: Number(maxDelay),
        },
      });
      toast.success("Task created");
      setOpen(false);
      setName("");
      setTargets("");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={!accounts.length}>
          New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New join task</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.username || a.first_name || a.phone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Task name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <Label>Targets (one per line, @username or t.me/link)</Label>
            <Textarea rows={6} value={targets} onChange={(e) => setTargets(e.target.value)} required />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Label>Min delay (s)</Label>
              <Input type="number" value={minDelay} onChange={(e) => setMinDelay(e.target.value)} />
            </div>
            <div className="flex-1">
              <Label>Max delay (s)</Label>
              <Input type="number" value={maxDelay} onChange={(e) => setMaxDelay(e.target.value)} />
            </div>
          </div>
          <Button type="submit" disabled={busy || !accountId} className="w-full">
            {busy ? "Creating…" : "Create task"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}