import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getJoinIntegrity,
  runJoinSweepNow,
  unblockJoinTarget,
  clearJoinFingerprint,
  retryDroppedMembership,
} from "@/lib/join-integrity.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/join-integrity")({
  component: JoinIntegrityPage,
  head: () => ({
    meta: [
      { title: "Join Integrity — Telemang" },
      { name: "description", content: "Verify what every invite link really resolved to, track approvals, and see dropped or blocked joins." },
      { property: "og:title", content: "Join Integrity — Telemang" },
      { property: "og:description", content: "Fingerprints, membership verification sweeps, approval tracking and permanent block list for Telegram joins." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  errorComponent: ({ error }) => <div className="p-6 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

const statusTone: Record<string, string> = {
  joined: "bg-primary/15 text-primary",
  accepted: "bg-primary/15 text-primary",
  requested: "bg-amber-500/15 text-amber-500",
  dropped: "bg-destructive/15 text-destructive",
  banned: "bg-destructive/15 text-destructive",
  failed: "bg-muted text-muted-foreground",
};

function prettyKey(key: string) {
  if (key.startsWith("user:")) return `@${key.slice(5)}`;
  if (key.startsWith("invite:")) return `+${key.slice(7, 15)}…`;
  if (key.startsWith("id:")) return `chat ${key.slice(3)}`;
  return key;
}

function JoinIntegrityPage() {
  const qc = useQueryClient();
  const load = useServerFn(getJoinIntegrity);
  const sweep = useServerFn(runJoinSweepNow);
  const unblock = useServerFn(unblockJoinTarget);
  const forgetFp = useServerFn(clearJoinFingerprint);
  const retry = useServerFn(retryDroppedMembership);

  const { data, isLoading } = useQuery({
    queryKey: ["join-integrity"],
    queryFn: () => load(),
    refetchInterval: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["join-integrity"] });

  const sweepMut = useMutation({
    mutationFn: () => sweep(),
    onSuccess: (s: any) => {
      toast.success(
        `Sweep done — checked ${s.checked}, confirmed ${s.confirmed}, accepted ${s.accepted}, dropped ${s.dropped}`,
      );
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Sweep failed"),
  });

  const accountLabel = (id: string | null) =>
    data?.accounts.find((a) => a.id === id)?.label ?? "—";

  const memberships = data?.memberships ?? [];
  const pending = memberships.filter((m) => m.status === "requested");
  const problems = memberships.filter((m) => m.status === "dropped" || m.status === "banned");
  const drifted = (data?.fingerprints ?? []).filter((f) => Array.isArray(f.drift) && f.drift.length);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Join Integrity</h1>
          <p className="text-sm text-muted-foreground">
            What each link really resolved to, whether joins actually stuck, and which pairs can never work.
          </p>
        </div>
        <Button onClick={() => sweepMut.mutate()} disabled={sweepMut.isPending}>
          {sweepMut.isPending ? "Verifying…" : "Run verification sweep"}
        </Button>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Tracked links" value={data?.fingerprints.length ?? 0} />
        <Stat label="Awaiting approval" value={pending.length} />
        <Stat label="Dropped / banned" value={problems.length} />
        <Stat label="Blocked pairs" value={data?.blocklist.length ?? 0} />
      </div>

      {drifted.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive text-base">Identity drift detected</CardTitle>
            <CardDescription>These links no longer resolve to the same chat they did before.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {drifted.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{prettyKey(f.target_key)}</span>
                <span className="text-muted-foreground">{(f.drift as string[]).join("; ")}</span>
                <Button size="sm" variant="ghost" onClick={() => forgetFp({ data: { id: f.id } }).then(invalidate)}>
                  Reset
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="memberships">
        <TabsList>
          <TabsTrigger value="memberships">Memberships</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="fingerprints">Fingerprints</TabsTrigger>
          <TabsTrigger value="blocked">Blocked</TabsTrigger>
        </TabsList>

        <TabsContent value="memberships">
          <Card>
            <CardContent className="p-0 divide-y">
              {isLoading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && memberships.length === 0 && (
                <div className="p-4 text-sm text-muted-foreground">No joins recorded yet.</div>
              )}
              {memberships.map((m) => (
                <div key={m.id} className="p-3 flex flex-wrap items-center gap-2 text-sm">
                  <Badge className={statusTone[m.status] ?? ""} variant="secondary">{m.status}</Badge>
                  <span className="font-mono">{prettyKey(m.target_key)}</span>
                  <span className="text-muted-foreground">{accountLabel(m.account_id)}</span>
                  {m.chat_type && <span className="text-xs text-muted-foreground">{m.chat_type}</span>}
                  {m.verified_at && <span className="text-xs text-primary">verified</span>}
                  {m.error_code && <span className="text-xs text-destructive">{m.error_code}</span>}
                  {(m.status === "dropped" || m.status === "joined") && (
                    <Button size="sm" variant="ghost" className="ml-auto"
                      onClick={() => retry({ data: { id: m.id } }).then(invalidate)}>
                      Re-check now
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="approvals">
          <Card>
            <CardContent className="p-0 divide-y">
              {pending.length === 0 && (
                <div className="p-4 text-sm text-muted-foreground">No pending join requests.</div>
              )}
              {pending.map((m) => (
                <div key={m.id} className="p-3 flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary" className={statusTone.requested}>waiting</Badge>
                  <span className="font-mono">{prettyKey(m.target_key)}</span>
                  <span className="text-muted-foreground">{accountLabel(m.account_id)}</span>
                  <span className="text-xs text-muted-foreground ml-auto">checks: {m.checks}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fingerprints">
          <Card>
            <CardContent className="p-0 divide-y">
              {(data?.fingerprints ?? []).map((f) => (
                <div key={f.id} className="p-3 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{prettyKey(f.target_key)}</span>
                  <span>{f.title ?? "—"}</span>
                  {f.username && <span className="text-muted-foreground">@{f.username}</span>}
                  <Badge variant="outline">{f.chat_type ?? "unknown"}</Badge>
                  {f.requires_approval && <Badge variant="secondary">approval</Badge>}
                  {f.discussion_chat_id && <Badge variant="outline">discussion linked</Badge>}
                  <span className="text-xs text-muted-foreground ml-auto">id {f.chat_id ?? "—"}</span>
                </div>
              ))}
              {(data?.fingerprints.length ?? 0) === 0 && (
                <div className="p-4 text-sm text-muted-foreground">No links fingerprinted yet.</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="blocked">
          <Card>
            <CardContent className="p-0 divide-y">
              {(data?.blocklist ?? []).map((b) => (
                <div key={b.id} className="p-3 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{prettyKey(b.target_key)}</span>
                  <span className="text-muted-foreground">{accountLabel(b.account_id)}</span>
                  <span className="text-destructive text-xs">{b.reason}</span>
                  {b.error_code && <Badge variant="outline">{b.error_code}</Badge>}
                  <Button size="sm" variant="ghost" className="ml-auto"
                    onClick={() => unblock({ data: { id: b.id } }).then(invalidate)}>
                    Unblock
                  </Button>
                </div>
              ))}
              {(data?.blocklist.length ?? 0) === 0 && (
                <div className="p-4 text-sm text-muted-foreground">Nothing blocked.</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-2xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}