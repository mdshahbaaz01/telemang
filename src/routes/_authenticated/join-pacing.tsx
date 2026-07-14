import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  getJoinPacing,
  updateJoinPacing,
  listJoinAttempts,
  clearJoinAttempts,
  listJoinCache,
  clearJoinCacheEntry,
} from "@/lib/join-pacing.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/join-pacing")({
  beforeLoad: requireAdminBeforeLoad,
  component: JoinPacingPage,
  head: () => ({
    meta: [{ title: "Join Pacing — Telemang" }],
  }),
  errorComponent: ({ error }) => <div className="p-6 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

function JoinPacingPage() {
  const qc = useQueryClient();
  const load = useServerFn(getJoinPacing);
  const save = useServerFn(updateJoinPacing);
  const listAttempts = useServerFn(listJoinAttempts);
  const clearAttempts = useServerFn(clearJoinAttempts);
  const listCache = useServerFn(listJoinCache);
  const clearOne = useServerFn(clearJoinCacheEntry);

  const { data: pacing } = useQuery({ queryKey: ["join-pacing"], queryFn: () => load() });
  const { data: attempts } = useQuery({
    queryKey: ["join-attempts"],
    queryFn: () => listAttempts({ data: { limit: 150 } }),
    refetchInterval: 5000,
  });
  const { data: cache } = useQuery({
    queryKey: ["join-cache"],
    queryFn: () => listCache({ data: { limit: 200 } }),
    refetchInterval: 10000,
  });

  const [form, setForm] = useState({
    min_delay_ms: 800,
    max_delay_ms: 1500,
    batch_size: 5,
    cache_ttl_hours: 720,
    lock_ttl_seconds: 90,
  });
  useEffect(() => {
    if (pacing?.config) setForm(pacing.config);
  }, [pacing?.config]);

  const saveM = useMutation({
    mutationFn: () => save({ data: form }),
    onSuccess: () => {
      toast.success("Pacing saved");
      qc.invalidateQueries({ queryKey: ["join-pacing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clearM = useMutation({
    mutationFn: () => clearAttempts(),
    onSuccess: () => {
      toast.success("Attempt log cleared");
      qc.invalidateQueries({ queryKey: ["join-attempts"] });
    },
  });

  const resultColor: Record<string, string> = {
    joined: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
    requested: "bg-blue-500/15 text-blue-500 border-blue-500/30",
    skipped_cached: "bg-muted text-muted-foreground",
    skipped_locked: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    skipped: "bg-muted text-muted-foreground",
    flood: "bg-red-500/15 text-red-500 border-red-500/30",
    failed: "bg-red-500/15 text-red-500 border-red-500/30",
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Join Pacing & Cache</h1>
        <p className="text-sm text-muted-foreground">
          One join per (account, channel) at a time, cached across restarts. Tune speed here without redeploying.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pacing configuration</CardTitle>
          <CardDescription>
            Applies to both bot-flow joins and join tasks. Defaults: 800–1500 ms delay, batch 5, 30-day cache TTL, 90 s lock TTL.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              ["min_delay_ms", "Min delay (ms)"],
              ["max_delay_ms", "Max delay (ms)"],
              ["batch_size", "Batch size"],
              ["cache_ttl_hours", "Cache TTL (hours)"],
              ["lock_ttl_seconds", "Lock TTL (seconds)"],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={k}>{label}</Label>
              <Input
                id={k}
                type="number"
                value={form[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }))}
              />
            </div>
          ))}
          <div className="sm:col-span-2 lg:col-span-5 flex justify-end">
            <Button onClick={() => saveM.mutate()} disabled={saveM.isPending}>
              {saveM.isPending ? "Saving…" : "Save pacing"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="attempts">
        <TabsList>
          <TabsTrigger value="attempts">
            Attempts <Badge variant="secondary" className="ml-2">{attempts?.length ?? 0}</Badge>
          </TabsTrigger>
          <TabsTrigger value="cache">
            Cache <Badge variant="secondary" className="ml-2">{cache?.length ?? 0}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="attempts" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent join attempts</CardTitle>
                <CardDescription>Live — refreshes every 5 s. FloodWait diagnostics per account/channel.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => clearM.mutate()}>Clear log</Button>
            </CardHeader>
            <CardContent>
              <div className="max-h-[520px] overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2">Time</th>
                      <th className="p-2">Account</th>
                      <th className="p-2">Target</th>
                      <th className="p-2">Source</th>
                      <th className="p-2">Result</th>
                      <th className="p-2">Wait</th>
                      <th className="p-2">Flood</th>
                      <th className="p-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(attempts ?? []).map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="p-2 whitespace-nowrap text-muted-foreground">
                          {new Date(r.created_at).toLocaleTimeString()}
                        </td>
                        <td className="p-2 font-mono">{r.account_id?.slice(0, 8) ?? "—"}</td>
                        <td className="p-2 font-mono">{r.target}</td>
                        <td className="p-2">{r.source}</td>
                        <td className="p-2">
                          <Badge variant="outline" className={resultColor[r.result] ?? ""}>{r.result}</Badge>
                        </td>
                        <td className="p-2">{r.wait_ms != null ? `${r.wait_ms} ms` : "—"}</td>
                        <td className="p-2">{r.flood_wait_seconds != null ? `${r.flood_wait_seconds} s` : "—"}</td>
                        <td className="p-2 max-w-[240px] truncate" title={r.error ?? ""}>{r.error ?? ""}</td>
                      </tr>
                    ))}
                    {!attempts?.length && (
                      <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No attempts logged yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cache" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Persistent join cache</CardTitle>
              <CardDescription>
                Per-(account, channel) records with TTL. In-flight rows hold the lock; joined/requested rows block re-joins.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[520px] overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2">Account</th>
                      <th className="p-2">Target</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Source</th>
                      <th className="p-2">Attempts</th>
                      <th className="p-2">Expires</th>
                      <th className="p-2">Updated</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(cache ?? []).map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="p-2 font-mono">{r.account_id.slice(0, 8)}</td>
                        <td className="p-2 font-mono">{r.target_key}</td>
                        <td className="p-2">
                          <Badge variant="outline" className={resultColor[r.status] ?? ""}>{r.status}</Badge>
                        </td>
                        <td className="p-2">{r.source ?? "—"}</td>
                        <td className="p-2">{r.attempts}</td>
                        <td className="p-2 text-muted-foreground">
                          {r.expires_at ? new Date(r.expires_at).toLocaleString() : "—"}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {new Date(r.updated_at).toLocaleTimeString()}
                        </td>
                        <td className="p-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              await clearOne({ data: { id: r.id } });
                              qc.invalidateQueries({ queryKey: ["join-cache"] });
                            }}
                          >Clear</Button>
                        </td>
                      </tr>
                    ))}
                    {!cache?.length && (
                      <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Cache is empty.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}