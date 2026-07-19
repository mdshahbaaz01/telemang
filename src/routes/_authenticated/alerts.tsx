import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AdminGate } from "@/components/AdminGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ArrowLeft, Bell, RefreshCw, Save } from "lucide-react";
import {
  getReferralStats,
  getNotificationSettings,
  saveNotificationSettings,
  listNotificationLogs,
} from "@/lib/actions.functions";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/alerts")({
  beforeLoad: requireAdminBeforeLoad,
  component: () => (
    <AdminGate>
      <AlertsPage />
    </AdminGate>
  ),
});

function AlertsPage() {
  const qc = useQueryClient();
  const getStats = useServerFn(getReferralStats);
  const getSettings = useServerFn(getNotificationSettings);
  const saveSettings = useServerFn(saveNotificationSettings);
  const listLogs = useServerFn(listNotificationLogs);

  const statsQ = useQuery({ queryKey: ["referral-stats"], queryFn: () => getStats() });
  const settingsQ = useQuery({ queryKey: ["notification-settings"], queryFn: () => getSettings() });
  const logsQ = useQuery({ queryKey: ["notification-logs"], queryFn: () => listLogs(), refetchInterval: 30_000, refetchIntervalInBackground: false, staleTime: 15_000 });

  const [form, setForm] = useState({
    emailEnabled: false,
    telegramEnabled: false,
    emailTo: "",
    telegramChat: "",
    alertSuccess: true,
    alertFailure: true,
    alertAccount: true,
    alertOnBan: true,
    alertOnPeerFlood: true,
    alertOnJobFailure: true,
    dailySummaryIstTime: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settingsQ.data) setForm(settingsQ.data);
  }, [settingsQ.data]);

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings({ data: form });
      toast.success("Alert settings saved");
      await qc.invalidateQueries({ queryKey: ["notification-settings"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-8">
        <Link to="/dashboard" className="inline-flex items-center gap-1 text-sm text-primary underline">
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-2xl font-semibold tracking-tight">Alerts & referrals</h1>
          <Button variant="outline" size="sm" onClick={() => { qc.invalidateQueries({ queryKey: ["referral-stats"] }); qc.invalidateQueries({ queryKey: ["notification-logs"] }); }}>
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
        </div>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold">Alert settings</h2>
            </div>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.emailEnabled} onCheckedChange={(v) => setForm((f) => ({ ...f, emailEnabled: !!v }))} />
                Email alerts
              </label>
              <div>
                <Label>Email address</Label>
                <Input value={form.emailTo} onChange={(e) => setForm((f) => ({ ...f, emailTo: e.target.value }))} placeholder="you@example.com" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.telegramEnabled} onCheckedChange={(v) => setForm((f) => ({ ...f, telegramEnabled: !!v }))} />
                Telegram alerts
              </label>
              <div>
                <Label>Telegram chat ID / handle</Label>
                <Input value={form.telegramChat} onChange={(e) => setForm((f) => ({ ...f, telegramChat: e.target.value }))} placeholder="@channel or chat id" />
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-3">
                <label className="flex items-center gap-2"><Checkbox checked={form.alertSuccess} onCheckedChange={(v) => setForm((f) => ({ ...f, alertSuccess: !!v }))} />Success</label>
                <label className="flex items-center gap-2"><Checkbox checked={form.alertFailure} onCheckedChange={(v) => setForm((f) => ({ ...f, alertFailure: !!v }))} />Failure</label>
                <label className="flex items-center gap-2"><Checkbox checked={form.alertAccount} onCheckedChange={(v) => setForm((f) => ({ ...f, alertAccount: !!v }))} />FloodWait</label>
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-3 border-t border-border pt-3">
                <label className="flex items-center gap-2"><Checkbox checked={form.alertOnBan} onCheckedChange={(v) => setForm((f) => ({ ...f, alertOnBan: !!v }))} />Account banned</label>
                <label className="flex items-center gap-2"><Checkbox checked={form.alertOnPeerFlood} onCheckedChange={(v) => setForm((f) => ({ ...f, alertOnPeerFlood: !!v }))} />Peer flood</label>
                <label className="flex items-center gap-2"><Checkbox checked={form.alertOnJobFailure} onCheckedChange={(v) => setForm((f) => ({ ...f, alertOnJobFailure: !!v }))} />Job failure</label>
              </div>
              <div>
                <Label>Daily summary time (IST, HH:MM)</Label>
                <Input value={form.dailySummaryIstTime} onChange={(e) => setForm((f) => ({ ...f, dailySummaryIstTime: e.target.value }))} placeholder="20:00 (blank = off)" />
              </div>
              <Button onClick={save} disabled={saving}>
                <Save className="mr-1 h-4 w-4" /> {saving ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 font-semibold">Referral tracker</h2>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="py-2 pr-3">Code</th><th className="py-2 pr-3">Runs</th><th className="py-2 pr-3">OK</th><th className="py-2 pr-3">Fail</th><th className="py-2">Last run</th></tr>
                </thead>
                <tbody>
                  {(statsQ.data ?? []).map((r) => (
                    <tr key={r.code} className="border-t border-border">
                      <td className="py-2 pr-3 font-mono">{r.code}</td>
                      <td className="py-2 pr-3">{r.runs}</td>
                      <td className="py-2 pr-3 text-emerald-600 dark:text-emerald-400">{r.ok}</td>
                      <td className="py-2 pr-3 text-destructive">{r.fail}</td>
                      <td className="py-2 text-xs text-muted-foreground">{r.lastRun ? new Date(r.lastRun).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                  {!statsQ.isLoading && !(statsQ.data ?? []).length && (
                    <tr><td colSpan={5} className="py-4 text-sm text-muted-foreground">No referral runs yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 font-semibold">Alert log</h2>
          <div className="max-h-96 space-y-2 overflow-auto">
            {(logsQ.data ?? []).map((log) => (
              <div key={log.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{log.event}</span>
                  <span className="font-medium">{log.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{new Date(log.created_at).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{log.body}</p>
                {log.error && <p className="mt-1 text-xs text-destructive">{log.error}</p>}
              </div>
            ))}
            {!logsQ.isLoading && !(logsQ.data ?? []).length && <p className="text-sm text-muted-foreground">No alerts logged yet.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}