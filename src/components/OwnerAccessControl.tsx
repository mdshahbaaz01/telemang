import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ownerListAccessOverview,
  ownerListRequests,
  ownerDecideRequest,
  ownerSetRole,
  ownerSetFeature,
  ownerSetUserSettings,
  FEATURE_KEYS,
  type FeatureKey,
} from "@/lib/owner-manage.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Check, X, ShieldCheck, Crown, User as UserIcon } from "lucide-react";

export function OwnerAccessControl() {
  const qc = useQueryClient();
  const overviewFn = useServerFn(ownerListAccessOverview);
  const requestsFn = useServerFn(ownerListRequests);
  const decideFn = useServerFn(ownerDecideRequest);
  const setRoleFn = useServerFn(ownerSetRole);
  const setFeatureFn = useServerFn(ownerSetFeature);
  const setSettingsFn = useServerFn(ownerSetUserSettings);

  const overviewQ = useQuery({ queryKey: ["owner-access-overview"], queryFn: () => overviewFn() });
  const requestsQ = useQuery({ queryKey: ["owner-requests"], queryFn: () => requestsFn(), refetchInterval: 15000 });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["owner-access-overview"] });
    qc.invalidateQueries({ queryKey: ["owner-requests"] });
  };

  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; accountLimit?: number }) => decideFn({ data: v }),
    onSuccess: () => { toast.success("Request updated"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: "user" | "admin" | "owner" }) => setRoleFn({ data: v }),
    onSuccess: () => { toast.success("Role changed"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const changeFeature = useMutation({
    mutationFn: (v: { userId: string; key: string; allowed: boolean }) => setFeatureFn({ data: v }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error((e as Error).message),
  });
  const changeSettings = useMutation({
    mutationFn: (v: { userId: string; approved?: boolean; accountLimit?: number; notes?: string }) =>
      setSettingsFn({ data: v }),
    onSuccess: () => { toast.success("Saved"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const pending = useMemo(
    () => (requestsQ.data ?? []).filter((r) => r.status === "pending"),
    [requestsQ.data],
  );

  return (
    <section className="mt-8 space-y-6 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Owner Access Control</h2>
        <p className="text-sm text-muted-foreground">
          Approve account-add requests, change roles, and toggle features per user.
        </p>
      </div>

      {/* Pending requests */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="secondary">Pending requests ({pending.length})</Badge>
        </div>
        {pending.length === 0 ? (
          <p className="text-xs text-muted-foreground">No pending requests.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <PendingRow key={r.id} r={r} onDecide={(approve, limit) =>
                decide.mutate({ id: r.id, approve, accountLimit: limit })
              } />
            ))}
          </div>
        )}
      </div>

      {/* Users overview */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="secondary">Users ({overviewQ.data?.length ?? 0})</Badge>
        </div>
        <div className="space-y-3">
          {(overviewQ.data ?? []).map((u) => (
            <UserRow
              key={u.id}
              u={u}
              onRole={(role) => changeRole.mutate({ userId: u.id, role })}
              onFeature={(key, allowed) => changeFeature.mutate({ userId: u.id, key, allowed })}
              onSettings={(v) => changeSettings.mutate({ userId: u.id, ...v })}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function PendingRow({
  r,
  onDecide,
}: {
  r: { id: string; email: string; message: string | null; requested_limit: number | null; created_at: string };
  onDecide: (approve: boolean, limit?: number) => void;
}) {
  const [limit, setLimit] = useState(String(r.requested_limit ?? 1));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{r.email || r.id.slice(0, 8)}</div>
        <div className="text-xs text-muted-foreground">
          asked for {r.requested_limit ?? 1} · {new Date(r.created_at).toLocaleString()}
        </div>
        {r.message && <div className="mt-1 text-xs">{r.message}</div>}
      </div>
      <div className="flex items-center gap-1">
        <Input
          className="h-8 w-20"
          type="number"
          min={1}
          max={50}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
        <Button size="sm" onClick={() => onDecide(true, Number(limit) || 1)}>
          <Check className="mr-1 h-3.5 w-3.5" /> Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide(false)}>
          <X className="mr-1 h-3.5 w-3.5" /> Reject
        </Button>
      </div>
    </div>
  );
}

function UserRow({
  u,
  onRole,
  onFeature,
  onSettings,
}: {
  u: {
    id: string;
    email: string;
    roles: string[];
    isOwner: boolean;
    isAdmin: boolean;
    accountAddApproved: boolean;
    accountLimit: number;
    accountCount: number;
    features: Record<string, boolean>;
  };
  onRole: (role: "user" | "admin" | "owner") => void;
  onFeature: (key: string, allowed: boolean) => void;
  onSettings: (v: { approved?: boolean; accountLimit?: number; notes?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(String(u.accountLimit));
  const currentRole = u.isOwner ? "owner" : u.isAdmin ? "admin" : "user";
  return (
    <div className="rounded border border-border bg-background/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {u.isOwner ? <Crown className="h-3.5 w-3.5 text-primary" /> : u.isAdmin ? <ShieldCheck className="h-3.5 w-3.5" /> : <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="truncate font-medium">{u.email || u.id.slice(0, 8)}</span>
            <Badge variant="outline" className="text-[10px] uppercase">{currentRole}</Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            accounts {u.accountCount}/{u.accountLimit || "—"} · {u.accountAddApproved ? "approved" : "not approved"}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {(["user","admin","owner"] as const).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === currentRole ? "default" : "outline"}
              onClick={() => onRole(r)}
              disabled={r === currentRole || u.isOwner && r === "owner"}
            >
              {r}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Manage"}
          </Button>
        </div>
      </div>

      {open && !u.isOwner && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              Account limit
              <Input
                className="mt-1 h-8 w-24"
                type="number"
                min={0}
                max={50}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs">Approved</span>
              <Switch
                checked={u.accountAddApproved}
                onCheckedChange={(v) => onSettings({ approved: v })}
              />
            </div>
            <Button
              size="sm"
              onClick={() => onSettings({ accountLimit: Number(limit) || 0 })}
            >
              Save limit
            </Button>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium">Features</div>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
              {FEATURE_KEYS.map((k: FeatureKey) => {
                const allowed = u.features[k] !== false;
                return (
                  <label key={k} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs">
                    <span className="truncate">{k}</span>
                    <Switch
                      checked={allowed}
                      onCheckedChange={(v) => onFeature(k, v)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
