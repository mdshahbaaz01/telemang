import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ownerListUsers,
  ownerToggleAdmin,
  ownerListAccounts,
  ownerSetAccountStatus,
  ownerListLogins,
} from "@/lib/owner.functions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AdminGate, useMyRole } from "@/components/AdminGate";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/owner")({
  component: () => (
    <AdminGate>
      <OwnerPanel />
    </AdminGate>
  ),
});

function OwnerPanel() {
  const me = useMyRole();
  const qc = useQueryClient();
  const usersFn = useServerFn(ownerListUsers);
  const accountsFn = useServerFn(ownerListAccounts);
  const loginsFn = useServerFn(ownerListLogins);
  const toggleAdmin = useServerFn(ownerToggleAdmin);
  const setAcctStatus = useServerFn(ownerSetAccountStatus);

  const usersQ = useQuery({ queryKey: ["owner-users"], queryFn: () => usersFn() });
  const acctsQ = useQuery({ queryKey: ["owner-accts"], queryFn: () => accountsFn() });
  const loginsQ = useQuery({ queryKey: ["owner-logins"], queryFn: () => loginsFn() });

  const roleMut = useMutation({
    mutationFn: (v: { userId: string; makeAdmin: boolean }) =>
      toggleAdmin({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["owner-users"] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const acctMut = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      setAcctStatus({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["owner-accts"] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const meId = me.data?.userId;

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
        <div className="mb-8 flex items-center gap-3">
          <Link to="/dashboard">
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Owner Panel</h1>
            <p className="text-sm text-muted-foreground">
              Manage users, accounts, and recent logins
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8">
          <section className="rounded-lg border border-border bg-card p-4 md:p-6">
            <h2 className="mb-4 text-lg font-semibold">
              Users ({usersQ.data?.length ?? 0})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3">Email</th>
                    <th className="py-2 pr-3">Confirmed</th>
                    <th className="py-2 pr-3">Last sign-in</th>
                    <th className="py-2 pr-3">Roles</th>
                    <th className="py-2 pr-3">Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {(usersQ.data ?? []).map((u) => {
                    const isAdmin = u.roles.includes("admin");
                    const disabled = u.id === meId; // can't demote self
                    return (
                      <tr key={u.id} className="border-b border-border/50">
                        <td className="py-2 pr-3 font-medium">{u.email}</td>
                        <td className="py-2 pr-3">
                          {u.confirmed ? (
                            <span className="text-xs text-green-500">yes</span>
                          ) : (
                            <span className="text-xs text-yellow-500">no</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {u.last_sign_in_at
                            ? new Date(u.last_sign_in_at).toLocaleString()
                            : "—"}
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {u.roles.join(", ") || "user"}
                        </td>
                        <td className="py-2 pr-3">
                          <Switch
                            checked={isAdmin}
                            disabled={disabled || roleMut.isPending}
                            onCheckedChange={(v) =>
                              roleMut.mutate({ userId: u.id, makeAdmin: !!v })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 md:p-6">
            <h2 className="mb-4 text-lg font-semibold">
              Accounts ({acctsQ.data?.length ?? 0})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Phone</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Last update</th>
                    <th className="py-2 pr-3">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {(acctsQ.data ?? []).map((a) => {
                    const enabled = a.status !== "disabled";
                    return (
                      <tr key={a.id} className="border-b border-border/50">
                        <td className="py-2 pr-3 font-medium">
                          {a.first_name || a.username || "—"}
                        </td>
                        <td className="py-2 pr-3 text-xs">{a.phone}</td>
                        <td className="py-2 pr-3 text-xs">
                          {a.status}
                          {a.last_error ? (
                            <span className="ml-1 text-destructive">
                              · {a.last_error}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {new Date(a.updated_at ?? a.created_at).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3">
                          <Switch
                            checked={enabled}
                            disabled={acctMut.isPending}
                            onCheckedChange={(v) =>
                              acctMut.mutate({ id: a.id, enabled: !!v })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 md:p-6">
            <h2 className="mb-4 text-lg font-semibold">
              Recent logins ({loginsQ.data?.length ?? 0})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3">Phone</th>
                    <th className="py-2 pr-3">api_id</th>
                    <th className="py-2 pr-3">Stage</th>
                    <th className="py-2 pr-3">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {(loginsQ.data ?? []).map((l) => (
                    <tr key={l.id} className="border-b border-border/50">
                      <td className="py-2 pr-3">{l.phone}</td>
                      <td className="py-2 pr-3 text-xs">{l.api_id}</td>
                      <td className="py-2 pr-3 text-xs">{l.stage}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {new Date(l.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  {!loginsQ.data?.length && (
                    <tr>
                      <td
                        className="py-3 text-xs text-muted-foreground"
                        colSpan={4}
                      >
                        No in-flight login attempts.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
