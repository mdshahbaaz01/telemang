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
import {
  listAccountGroups,
  createAccountGroup,
  renameAccountGroup,
  deleteAccountGroup,
  setGroupMembers,
} from "@/lib/account-groups.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { FloodWaitBadge } from "@/components/FloodWaitBadge";
import { AdminGate, useMyRole } from "@/components/AdminGate";
import { ArrowLeft, MessageSquare, Plus, Trash2, Users, ShieldCheck, UserCog, Activity, KeyRound, LogIn, CircleDot, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useMemo, useState } from "react";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/owner")({
  beforeLoad: requireAdminBeforeLoad,
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

  // Load Noir & Gold fonts (JetBrains Mono + Work Sans) — scoped to this page's usage via inline font-family below.
  useEffect(() => {
    const href =
      "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&family=Work+Sans:wght@400;500;600&display=swap";
    if (document.querySelector(`link[data-owner-fonts]`)) return;
    const pre1 = document.createElement("link");
    pre1.rel = "preconnect";
    pre1.href = "https://fonts.googleapis.com";
    const pre2 = document.createElement("link");
    pre2.rel = "preconnect";
    pre2.href = "https://fonts.gstatic.com";
    pre2.crossOrigin = "anonymous";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-owner-fonts", "1");
    document.head.append(pre1, pre2, link);
  }, []);

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

  const stats = useMemo(() => {
    const users = usersQ.data ?? [];
    const accts = acctsQ.data ?? [];
    const logins = loginsQ.data ?? [];
    return {
      users: users.length,
      admins: users.filter((u: any) => u.roles?.includes("admin")).length,
      accounts: accts.length,
      activeAccounts: accts.filter((a: any) => a.status !== "disabled").length,
      logins: logins.length,
    };
  }, [usersQ.data, acctsQ.data, loginsQ.data]);

  return (
    <main className="owner-page min-h-dvh" aria-labelledby="owner-title">
      <OwnerStyles />
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-10">
        {/* Header */}
        <header className="mb-6 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 md:mb-10">
          <Link to="/dashboard" aria-label="Back to dashboard">
            <Button variant="ghost" size="icon" className="owner-back min-h-11 min-w-11" aria-label="Back to dashboard">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[color:var(--owner-gold)]">
              <span className="owner-hairline" aria-hidden />
              <span>Control</span>
            </div>
            <h1 id="owner-title" className="owner-display truncate text-2xl leading-tight sm:text-3xl">
              Owner Panel
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage users, accounts, and recent logins.
            </p>
          </div>
        </header>

        {/* KPI stats */}
        <section aria-label="At a glance" className="mb-6 grid grid-cols-2 gap-3 md:mb-10 md:grid-cols-4">
          <StatTile icon={UserCog} label="Users" value={stats.users} sub={`${stats.admins} admin${stats.admins === 1 ? "" : "s"}`} loading={usersQ.isLoading} />
          <StatTile icon={ShieldCheck} label="Accounts" value={stats.accounts} sub={`${stats.activeAccounts} active`} loading={acctsQ.isLoading} accent />
          <StatTile icon={Activity} label="Active" value={stats.activeAccounts} sub={`${stats.accounts - stats.activeAccounts} disabled`} loading={acctsQ.isLoading} />
          <StatTile icon={LogIn} label="In-flight logins" value={stats.logins} sub={stats.logins ? "pending" : "quiet"} loading={loginsQ.isLoading} />
        </section>

        <div className="grid grid-cols-1 gap-6 md:gap-8">
          {/* Users */}
          <OwnerCard
            icon={UserCog}
            title="Users"
            count={usersQ.data?.length ?? 0}
            subtitle="Grant or revoke admin access"
          >
            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="owner-table w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col">Confirmed</th>
                    <th scope="col">Last sign-in</th>
                    <th scope="col">Roles</th>
                    <th scope="col" className="text-right">Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {(usersQ.data ?? []).map((u) => {
                    const isAdmin = u.roles.includes("admin");
                    const disabled = u.id === meId;
                    return (
                      <tr key={u.id}>
                        <td className="font-medium">
                          <span className="truncate">{u.email}</span>
                          {disabled && <span className="ml-2 text-[10px] uppercase tracking-widest text-[color:var(--owner-gold)]">you</span>}
                        </td>
                        <td>
                          <StatusDot ok={u.confirmed} labelOk="Confirmed" labelNo="Pending" />
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "—"}
                        </td>
                        <td>
                          {isAdmin ? (
                            <Badge className="owner-badge-gold">admin</Badge>
                          ) : (
                            <Badge variant="outline" className="owner-badge-muted">user</Badge>
                          )}
                        </td>
                        <td className="text-right">
                          <Switch
                            aria-label={`Toggle admin for ${u.email}`}
                            checked={isAdmin}
                            disabled={disabled || roleMut.isPending}
                            onCheckedChange={(v) => roleMut.mutate({ userId: u.id, makeAdmin: !!v })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {!usersQ.data?.length && (
                    <tr><td colSpan={5} className="py-6 text-center text-xs text-muted-foreground">No users yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <ul className="space-y-2 md:hidden">
              {(usersQ.data ?? []).map((u) => {
                const isAdmin = u.roles.includes("admin");
                const disabled = u.id === meId;
                return (
                  <li key={u.id} className="owner-row-card">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{u.email}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <StatusDot ok={u.confirmed} labelOk="confirmed" labelNo="pending" />
                          <span>·</span>
                          <span>{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "never"}</span>
                          {isAdmin && <Badge className="owner-badge-gold">admin</Badge>}
                        </div>
                      </div>
                      <Switch
                        aria-label={`Toggle admin for ${u.email}`}
                        checked={isAdmin}
                        disabled={disabled || roleMut.isPending}
                        onCheckedChange={(v) => roleMut.mutate({ userId: u.id, makeAdmin: !!v })}
                      />
                    </div>
                  </li>
                );
              })}
              {!usersQ.data?.length && (
                <li className="py-6 text-center text-xs text-muted-foreground">No users yet.</li>
              )}
            </ul>
          </OwnerCard>

          {/* Accounts */}
          <OwnerCard
            icon={ShieldCheck}
            title="Accounts"
            count={acctsQ.data?.length ?? 0}
            subtitle="Enable, disable, and jump into any session"
          >
            <div className="hidden overflow-x-auto md:block">
              <table className="owner-table w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Phone</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last update</th>
                    <th scope="col">Enabled</th>
                    <th scope="col" className="text-right">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {(acctsQ.data ?? []).map((a) => {
                    const enabled = a.status !== "disabled";
                    const displayName = a.first_name || a.username || "—";
                    return (
                      <tr key={a.id}>
                        <td className="font-medium">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="owner-avatar" aria-hidden>{initials(displayName)}</span>
                            <span className="truncate">{displayName}</span>
                          </div>
                        </td>
                        <td className="text-xs text-muted-foreground">{a.phone}</td>
                        <td className="text-xs">
                          <span className="inline-flex items-center gap-2">
                            <StatusDot ok={enabled} labelOk={a.status} labelNo={a.status} />
                            <FloodWaitBadge pausedUntil={(a as any).paused_until} lastError={a.last_error} compact />
                          </span>
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {new Date(a.updated_at ?? a.created_at).toLocaleString()}
                        </td>
                        <td>
                          <Switch
                            aria-label={`Toggle account ${displayName}`}
                            checked={enabled}
                            disabled={acctMut.isPending}
                            onCheckedChange={(v) => acctMut.mutate({ id: a.id, enabled: !!v })}
                          />
                        </td>
                        <td className="text-right">
                          <Button asChild size="sm" variant="ghost" className="owner-open-btn">
                            <Link to="/accounts/$id" params={{ id: a.id }} aria-label={`Open account ${displayName}`}>
                              <MessageSquare className="mr-1 h-3.5 w-3.5" /> View
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                  {!acctsQ.data?.length && (
                    <tr><td colSpan={6} className="py-6 text-center text-xs text-muted-foreground">No accounts connected.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 md:hidden">
              {(acctsQ.data ?? []).map((a) => {
                const enabled = a.status !== "disabled";
                const displayName = a.first_name || a.username || "—";
                return (
                  <li key={a.id} className="owner-row-card">
                    <div className="flex items-start gap-3">
                      <span className="owner-avatar shrink-0" aria-hidden>{initials(displayName)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{displayName}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{a.phone}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                          <StatusDot ok={enabled} labelOk={a.status} labelNo={a.status} />
                          <FloodWaitBadge pausedUntil={(a as any).paused_until} lastError={a.last_error} compact />
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <Switch
                          aria-label={`Toggle account ${displayName}`}
                          checked={enabled}
                          disabled={acctMut.isPending}
                          onCheckedChange={(v) => acctMut.mutate({ id: a.id, enabled: !!v })}
                        />
                        <Button asChild size="sm" variant="ghost" className="owner-open-btn h-8 px-2">
                          <Link to="/accounts/$id" params={{ id: a.id }} aria-label={`Open account ${displayName}`}>
                            <MessageSquare className="mr-1 h-3.5 w-3.5" /> Open
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
              {!acctsQ.data?.length && (
                <li className="py-6 text-center text-xs text-muted-foreground">No accounts connected.</li>
              )}
            </ul>
          </OwnerCard>

          <AccountGroupsSection accounts={acctsQ.data ?? []} />

          {/* Recent logins */}
          <OwnerCard
            icon={KeyRound}
            title="Recent logins"
            count={loginsQ.data?.length ?? 0}
            subtitle="Login attempts currently in progress"
          >
            <div className="overflow-x-auto">
              <table className="owner-table w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col">Phone</th>
                    <th scope="col">api_id</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {(loginsQ.data ?? []).map((l) => (
                    <tr key={l.id}>
                      <td>{l.phone}</td>
                      <td className="text-xs">{l.api_id}</td>
                      <td className="text-xs"><Badge variant="outline" className="owner-badge-muted">{l.stage}</Badge></td>
                      <td className="text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                  {!loginsQ.data?.length && (
                    <tr>
                      <td className="py-6 text-center text-xs text-muted-foreground" colSpan={4}>
                        No in-flight login attempts.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </OwnerCard>
        </div>
      </div>
    </main>
  );
}

/* ---------- helpers ---------- */

function initials(name: string): string {
  const t = (name || "").trim();
  if (!t || t === "—") return "·";
  const parts = t.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase()).join("") || t[0]!.toUpperCase();
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  loading,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  sub?: string;
  loading?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={"owner-stat" + (accent ? " owner-stat--accent" : "")}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-[color:var(--owner-gold)]" aria-hidden />
      </div>
      <div className="mt-2 owner-display text-2xl sm:text-3xl">
        {loading ? <span className="owner-skeleton">—</span> : value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function OwnerCard({
  icon: Icon,
  title,
  count,
  subtitle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count?: number;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const storageKey = `owner-card-collapsed:${title}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(storageKey) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, collapsed ? "1" : "0");
  }, [storageKey, collapsed]);
  return (
    <section className="owner-card" aria-label={title}>
      <header className="owner-card__head">
        <div className="flex min-w-0 items-center gap-3">
          <span className="owner-icon-wrap" aria-hidden>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="owner-display text-base sm:text-lg">
              {title}
              {typeof count === "number" && (
                <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">({count})</span>
              )}
            </h2>
            {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-8 px-2 text-xs"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Minimize ${title}`}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          <span className="ml-1 hidden sm:inline">{collapsed ? "Expand" : "Minimize"}</span>
        </Button>
      </header>
      {!collapsed && <div className="owner-card__body">{children}</div>}
    </section>
  );
}

function StatusDot({ ok, labelOk, labelNo }: { ok: boolean; labelOk: string; labelNo: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <CircleDot
        className={"h-3 w-3 " + (ok ? "text-emerald-400" : "text-amber-400")}
        aria-hidden
      />
      <span className={ok ? "text-emerald-400" : "text-amber-400"}>{ok ? labelOk : labelNo}</span>
    </span>
  );
}

function OwnerStyles() {
  return (
    <style>{`
      .owner-page {
        --owner-gold: #c9a84c;
        --owner-gold-2: #f0d78c;
        --owner-ink: #0d0d0d;
        --owner-panel: color-mix(in oklab, var(--card) 88%, #0d0d0d 12%);
        font-family: "Work Sans", ui-sans-serif, system-ui, sans-serif;
        background:
          radial-gradient(1200px 500px at 12% -10%, color-mix(in oklab, var(--owner-gold) 10%, transparent), transparent 60%),
          radial-gradient(900px 400px at 100% 0%, color-mix(in oklab, var(--owner-gold) 6%, transparent), transparent 60%),
          var(--background);
      }
      .owner-page .owner-display {
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .owner-page .owner-hairline {
        display: inline-block; width: 22px; height: 1px;
        background: linear-gradient(90deg, var(--owner-gold), transparent);
      }
      .owner-page .owner-back { border: 1px solid color-mix(in oklab, var(--owner-gold) 30%, transparent); }
      .owner-page .owner-back:hover { background: color-mix(in oklab, var(--owner-gold) 12%, transparent); }

      .owner-page .owner-stat {
        position: relative;
        border: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
        background: linear-gradient(180deg, color-mix(in oklab, var(--card) 96%, transparent), color-mix(in oklab, var(--card) 82%, #000 18%));
        border-radius: 14px;
        padding: 14px 16px;
        transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
      }
      .owner-page .owner-stat:hover {
        transform: translateY(-1px);
        border-color: color-mix(in oklab, var(--owner-gold) 40%, transparent);
        box-shadow: 0 10px 30px -18px color-mix(in oklab, var(--owner-gold) 40%, transparent);
      }
      .owner-page .owner-stat--accent {
        border-color: color-mix(in oklab, var(--owner-gold) 45%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--owner-gold) 15%, transparent);
      }

      .owner-page .owner-card {
        border: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
        border-radius: 16px;
        background: linear-gradient(180deg, var(--card), color-mix(in oklab, var(--card) 90%, #000 10%));
        overflow: hidden;
      }
      .owner-page .owner-card__head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 14px 16px 12px 16px;
        border-bottom: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
        background: linear-gradient(180deg, color-mix(in oklab, var(--owner-gold) 5%, transparent), transparent);
      }
      .owner-page .owner-card__body { padding: 8px 12px 12px 12px; }
      @media (min-width: 768px) { .owner-page .owner-card__body { padding: 12px 18px 18px 18px; } }

      .owner-page .owner-icon-wrap {
        display: inline-grid; place-items: center;
        width: 32px; height: 32px; border-radius: 10px;
        background: color-mix(in oklab, var(--owner-gold) 14%, transparent);
        color: var(--owner-gold);
        border: 1px solid color-mix(in oklab, var(--owner-gold) 30%, transparent);
      }

      .owner-page .owner-table { border-collapse: separate; border-spacing: 0; }
      .owner-page .owner-table thead th {
        position: sticky; top: 0; z-index: 1;
        text-align: left; padding: 10px 12px;
        font-size: 10px; text-transform: uppercase; letter-spacing: .16em;
        color: color-mix(in oklab, var(--muted-foreground) 90%, var(--owner-gold) 10%);
        background: color-mix(in oklab, var(--card) 96%, transparent);
        border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
      }
      .owner-page .owner-table tbody td { padding: 12px; border-bottom: 1px solid color-mix(in oklab, var(--border) 40%, transparent); vertical-align: middle; }
      .owner-page .owner-table tbody tr { transition: background .15s ease; }
      .owner-page .owner-table tbody tr:hover { background: color-mix(in oklab, var(--owner-gold) 4%, transparent); }
      .owner-page .owner-table tbody tr:last-child td { border-bottom: 0; }

      .owner-page .owner-row-card {
        border: 1px solid color-mix(in oklab, var(--border) 55%, transparent);
        border-radius: 12px; padding: 12px;
        background: color-mix(in oklab, var(--card) 92%, transparent);
      }

      .owner-page .owner-avatar {
        display: inline-grid; place-items: center;
        width: 28px; height: 28px; border-radius: 8px;
        font: 600 11px/1 "JetBrains Mono", ui-monospace, monospace;
        color: var(--owner-ink);
        background: linear-gradient(135deg, var(--owner-gold), var(--owner-gold-2));
        border: 1px solid color-mix(in oklab, var(--owner-gold) 50%, transparent);
      }

      .owner-page .owner-badge-gold {
        background: linear-gradient(135deg, var(--owner-gold), var(--owner-gold-2));
        color: var(--owner-ink);
        border: none;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-weight: 600; letter-spacing: .04em;
      }
      .owner-page .owner-badge-muted {
        color: var(--muted-foreground);
        border-color: color-mix(in oklab, var(--border) 80%, transparent);
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-weight: 500; letter-spacing: .04em;
      }

      .owner-page .owner-open-btn:hover { color: var(--owner-gold); }
      .owner-page .owner-skeleton { color: color-mix(in oklab, var(--muted-foreground) 50%, transparent); }

      /* Focus visibility for a11y */
      .owner-page :where(a, button, [role="button"], input, select, textarea, [tabindex]):focus-visible {
        outline: 2px solid var(--owner-gold);
        outline-offset: 2px;
        border-radius: 8px;
      }
    `}</style>
  );
}

type AccountLite = { id: string; first_name?: string | null; username?: string | null; phone?: string | null };

function AccountGroupsSection({ accounts }: { accounts: AccountLite[] }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listAccountGroups);
  const createFn = useServerFn(createAccountGroup);
  const renameFn = useServerFn(renameAccountGroup);
  const deleteFn = useServerFn(deleteAccountGroup);
  const setMembersFn = useServerFn(setGroupMembers);

  const q = useQuery({ queryKey: ["account-groups"], queryFn: () => listFn() });
  const [newName, setNewName] = useState("");

  const create = useMutation({
    mutationFn: (name: string) => createFn({ data: { name } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["account-groups"] }); setNewName(""); },
    onError: (e) => toast.error((e as Error).message),
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => renameFn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-groups"] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-groups"] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const setMembers = useMutation({
    mutationFn: (v: { groupId: string; accountIds: string[] }) => setMembersFn({ data: v }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["account-groups"] }); toast.success("Group updated"); },
    onError: (e) => toast.error((e as Error).message),
  });

  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingMembers, setPendingMembers] = useState<Record<string, string[]>>({});

  const label = (a: AccountLite) => a.first_name || a.username || a.phone || a.id;

  return (
    <OwnerCard
      icon={Users}
      title="Account groups"
      count={q.data?.length ?? 0}
      subtitle="Reusable tags — pick a whole group in any action"
    >
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="e.g. India warm, Aged 2024, Test5"
          className="min-w-0 sm:max-w-xs"
          aria-label="New group name"
        />
        <Button
          size="sm"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate(newName.trim())}
          className="shrink-0"
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add group
        </Button>
      </div>
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data?.length === 0 && <p className="text-sm text-muted-foreground">No groups yet.</p>}
      <div className="space-y-2">
        {(q.data ?? []).map((g) => {
          const currentMembers = pendingMembers[g.id] ?? g.accountIds;
          const isOpen = expanded === g.id;
          const dirty = pendingMembers[g.id] && (pendingMembers[g.id].length !== g.accountIds.length ||
            pendingMembers[g.id].some((id) => !g.accountIds.includes(id)));
          return (
            <div key={g.id} className="owner-row-card !p-0">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 sm:flex sm:flex-wrap">
                <Input
                  defaultValue={g.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== g.name) rename.mutate({ id: g.id, name: v });
                  }}
                  className="min-w-0 h-8 text-sm sm:max-w-xs"
                  aria-label={`Rename group ${g.name}`}
                />
                <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                  <Badge variant="outline" className="owner-badge-muted">{g.accountIds.length} member{g.accountIds.length === 1 ? "" : "s"}</Badge>
                  <Button size="sm" variant="ghost" onClick={() => setExpanded(isOpen ? null : g.id)} aria-expanded={isOpen}>
                    {isOpen ? "Hide" : "Members"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    aria-label={`Delete group ${g.name}`}
                    onClick={() => { if (confirm(`Delete group "${g.name}"?`)) del.mutate(g.id); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {isOpen && (
                <div className="border-t border-border/50 px-3 py-2 space-y-2">
                  <div className="flex flex-wrap gap-1.5 max-h-48 overflow-auto">
                    {accounts.map((a) => {
                      const on = currentMembers.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => {
                            const next = on
                              ? currentMembers.filter((id) => id !== a.id)
                              : [...currentMembers, a.id];
                            setPendingMembers({ ...pendingMembers, [g.id]: next });
                          }}
                          className={
                            "text-xs rounded-full px-2 py-1 border transition-colors " +
                            (on
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background border-border hover:border-primary/50")
                          }
                        >
                          {label(a)}
                        </button>
                      );
                    })}
                    {!accounts.length && <p className="text-xs text-muted-foreground">No accounts.</p>}
                  </div>
                  {dirty && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => setMembers.mutate({ groupId: g.id, accountIds: currentMembers })}
                        disabled={setMembers.isPending}
                      >
                        Save {currentMembers.length} member(s)
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => {
                        const { [g.id]: _drop, ...rest } = pendingMembers;
                        setPendingMembers(rest);
                      }}>Cancel</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </OwnerCard>
  );
}
