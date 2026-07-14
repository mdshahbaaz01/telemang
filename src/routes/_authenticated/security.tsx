import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listMySessions,
  revokeSession,
  revokeOtherSessions,
} from "@/lib/sessions.functions";
import { getCurrentSessionKey } from "@/lib/session-heartbeat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader } from "@/components/ui/loader";
import { toast } from "sonner";
import { LogOut, Monitor, Smartphone, ShieldOff, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/security")({
  component: SecurityPage,
});

async function sha256Hex(input: string) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseUA(ua: string | null) {
  if (!ua) return { os: "Unknown device", osVersion: "", browser: "Browser", browserVersion: "", isMobile: false };
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
  const bMatch =
    /Edg\/([\d.]+)/.exec(ua) ? ["Edge", /Edg\/([\d.]+)/.exec(ua)![1]]
    : /OPR\/([\d.]+)/.exec(ua) ? ["Opera", /OPR\/([\d.]+)/.exec(ua)![1]]
    : /Firefox\/([\d.]+)/.exec(ua) ? ["Firefox", /Firefox\/([\d.]+)/.exec(ua)![1]]
    : /Chrome\/([\d.]+)/.exec(ua) ? ["Chrome", /Chrome\/([\d.]+)/.exec(ua)![1]]
    : /Version\/([\d.]+).*Safari/.exec(ua) ? ["Safari", /Version\/([\d.]+)/.exec(ua)![1]]
    : ["Browser", ""];
  const oMatch =
    /Windows NT ([\d.]+)/.exec(ua) ? ["Windows", /Windows NT ([\d.]+)/.exec(ua)![1]]
    : /Mac OS X ([\d_.]+)/.exec(ua) ? ["macOS", /Mac OS X ([\d_.]+)/.exec(ua)![1].replace(/_/g, ".")]
    : /Android ([\d.]+)/.exec(ua) ? ["Android", /Android ([\d.]+)/.exec(ua)![1]]
    : /(?:iPhone|iPad|CPU) OS ([\d_]+)/.exec(ua) ? ["iOS", /OS ([\d_]+)/.exec(ua)![1].replace(/_/g, ".")]
    : /Linux/.test(ua) ? ["Linux", ""]
    : ["Unknown", ""];
  return { os: oMatch[0], osVersion: oMatch[1], browser: bMatch[0], browserVersion: bMatch[1], isMobile };
}

function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 45) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function SecurityPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const listFn = useServerFn(listMySessions);
  const revokeFn = useServerFn(revokeSession);
  const revokeOthersFn = useServerFn(revokeOtherSessions);

  const q = useQuery({
    queryKey: ["my-sessions"],
    queryFn: () => listFn(),
    refetchInterval: 60_000,
  });
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  // Re-render every 30s so relative timestamps stay fresh.
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      const key = getCurrentSessionKey();
      setCurrentHash(await sha256Hex(key + ":" + data.user.id));
    })();
  }, []);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["my-sessions"] });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeFn({ data: { id } }),
    onSuccess: () => { toast.success("Session revoked"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const revokeOthers = useMutation({
    mutationFn: () => revokeOthersFn({ data: { currentSessionKey: getCurrentSessionKey() } }),
    onSuccess: () => { toast.success("Signed out other sessions"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const revokeAll = useMutation({
    mutationFn: async () => {
      // Use a random key that will hash to nothing on record → revokes every session.
      const bogus = crypto.randomUUID() + crypto.randomUUID();
      await revokeOthersFn({ data: { currentSessionKey: bogus } });
    },
    onSuccess: async () => {
      toast.success("All sessions signed out");
      await supabase.auth.signOut();
      nav({ to: "/auth" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows = useMemo(
    () =>
      (q.data ?? []).map((s) => ({
        ...s,
        isCurrent: currentHash != null && s.session_key === currentHash,
      })),
    [q.data, currentHash],
  );
  const activeOthers = rows.filter((r) => !r.isCurrent && !r.revoked_at).length;
  const activeAll = rows.filter((r) => !r.revoked_at).length;

  const refreshRow = async (id: string) => {
    setRefreshingId(id);
    try {
      await qc.refetchQueries({ queryKey: ["my-sessions"] });
    } finally {
      setRefreshingId(null);
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 md:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Security & Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Devices signed into your account. Revoke anything you don't recognize. Auto-refreshes every 60s.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            aria-label="Refresh sessions"
          >
            <RefreshCw className={`mr-1 h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => revokeOthers.mutate()}
            disabled={activeOthers === 0 || revokeOthers.isPending}
          >
            <ShieldOff className="mr-1 h-4 w-4" /> Sign out others ({activeOthers})
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (
                confirm(
                  `Sign out ALL ${activeAll} sessions including this one? You'll be returned to the sign-in page.`,
                )
              )
                revokeAll.mutate();
            }}
            disabled={activeAll === 0 || revokeAll.isPending}
          >
            <ShieldAlert className="mr-1 h-4 w-4" /> Revoke all
          </Button>
        </div>
      </header>

      {q.isLoading ? (
        <Loader size="sm" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No session history yet. It will populate on your next sign-in.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const ua = parseUA(r.user_agent);
            const Icon = ua.isMobile ? Smartphone : Monitor;
            return (
              <li
                key={r.id}
                className={`flex items-center gap-3 rounded-lg border bg-card p-3 ${
                  r.revoked_at ? "opacity-60" : ""
                } ${r.isCurrent ? "border-primary/50" : "border-border"}`}
              >
                <Icon className="h-5 w-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {ua.browser}
                      {ua.browserVersion && (
                        <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                          {ua.browserVersion.split(".").slice(0, 2).join(".")}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {ua.os}
                      {ua.osVersion && ` ${ua.osVersion}`} · {ua.isMobile ? "mobile" : "desktop"}
                    </span>
                    {r.isCurrent && <Badge className="bg-primary/10 text-primary">This device</Badge>}
                    {r.revoked_at && <Badge variant="outline">Revoked</Badge>}
                  </div>
                  <div
                    className="mt-0.5 text-[11px] text-muted-foreground"
                    title={`First seen ${new Date(r.created_at).toLocaleString()} — Last active ${new Date(
                      r.last_seen_at,
                    ).toLocaleString()}`}
                  >
                    <span className="font-medium text-foreground/80">
                      Last active {relTime(r.last_seen_at)}
                    </span>
                    <span> · First seen {relTime(r.created_at)}</span>
                    {r.ip_hash && (
                      <span className="font-mono"> · IP {r.ip_hash.slice(0, 8)}</span>
                    )}
                    {r.revoked_at && (
                      <span> · Revoked {relTime(r.revoked_at)}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Refresh session"
                    onClick={() => refreshRow(r.id)}
                    disabled={q.isFetching}
                    title="Refresh"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${
                        refreshingId === r.id && q.isFetching ? "animate-spin" : ""
                      }`}
                    />
                  </Button>
                  {!r.revoked_at && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revoke.mutate(r.id)}
                      disabled={revoke.isPending}
                    >
                      <LogOut className="mr-1 h-3.5 w-3.5" /> Revoke
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}