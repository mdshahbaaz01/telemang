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
import { LogOut, Monitor, Smartphone, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";

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
  if (!ua) return { device: "Unknown", browser: "" };
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : "Browser";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /Mac OS/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return { device: `${os} ${isMobile ? "· mobile" : "· desktop"}`.trim(), browser };
}

function SecurityPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listMySessions);
  const revokeFn = useServerFn(revokeSession);
  const revokeOthersFn = useServerFn(revokeOtherSessions);

  const q = useQuery({ queryKey: ["my-sessions"], queryFn: () => listFn() });
  const [currentHash, setCurrentHash] = useState<string | null>(null);

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

  const rows = (q.data ?? []).map((s) => ({
    ...s,
    isCurrent: currentHash != null && s.session_key === currentHash,
  }));
  const activeOthers = rows.filter((r) => !r.isCurrent && !r.revoked_at).length;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 md:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Security & Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Devices signed into your account. Revoke anything you don't recognize.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => revokeOthers.mutate()}
          disabled={activeOthers === 0 || revokeOthers.isPending}
        >
          <ShieldOff className="mr-1 h-4 w-4" /> Sign out other sessions ({activeOthers})
        </Button>
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
            const isMobile = /mobile/.test(ua.device);
            const Icon = isMobile ? Smartphone : Monitor;
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
                    <span className="text-sm font-medium">{ua.browser}</span>
                    <span className="text-xs text-muted-foreground">{ua.device}</span>
                    {r.isCurrent && <Badge className="bg-primary/10 text-primary">This device</Badge>}
                    {r.revoked_at && <Badge variant="outline">Revoked</Badge>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    First seen {new Date(r.created_at).toLocaleString()} · Last active{" "}
                    {new Date(r.last_seen_at).toLocaleString()}
                    {r.ip_hash && ` · IP hash ${r.ip_hash.slice(0, 8)}`}
                  </div>
                </div>
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
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}