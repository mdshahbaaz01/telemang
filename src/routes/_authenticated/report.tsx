import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { bulkReport, REPORT_REASONS } from "@/lib/report.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Flag, AlertTriangle } from "lucide-react";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/report")({
  beforeLoad: requireAdminBeforeLoad,
  head: () => ({
    meta: [
      { title: "Bulk Report — TeleManager Pro" },
      { name: "description", content: "Bulk report Telegram channels, groups, users, and bots from multiple accounts." },
    ],
  }),
  component: BulkReportPage,
});

type RunResult = {
  accountId: string;
  target: string;
  ok: boolean;
  mode: "peer" | "message";
  message: string;
};

const REASON_LABELS: Record<string, string> = {
  spam: "Spam",
  violence: "Violence",
  pornography: "Pornography",
  childAbuse: "Child abuse",
  copyright: "Copyright",
  geoIrrelevant: "Geo irrelevant",
  fake: "Fake account/scam",
  illegalDrugs: "Illegal drugs",
  personalDetails: "Personal details",
  other: "Other",
};

function BulkReportPage() {
  const listFn = useServerFn(listAccounts);
  const runFn = useServerFn(bulkReport);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listFn() });
  const accounts = accountsQ.data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetsText, setTargetsText] = useState("");
  const [reason, setReason] = useState<string>("spam");
  const [message, setMessage] = useState("");
  const [wholePeer, setWholePeer] = useState(true);
  const [delay, setDelay] = useState(1500);
  const [rangeStart, setRangeStart] = useState<string>("");
  const [rangeEnd, setRangeEnd] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);

  const targets = useMemo(
    () =>
      targetsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [targetsText],
  );

  const allChecked = selected.size > 0 && selected.size === accounts.length;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(accounts.map((a) => a.id)));
  const toggle = (id: string) => {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };

  const applyRange = () => {
    const s = Math.max(1, Number(rangeStart) || 1);
    const e = Math.max(s, Number(rangeEnd) || s);
    const picked = accounts.slice(s - 1, e).map((a) => a.id);
    setSelected(new Set(picked));
  };

  const canRun = selected.size > 0 && targets.length > 0 && !busy;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setResults([]);
    try {
      const res = await runFn({
        data: {
          accountIds: Array.from(selected),
          targets,
          reason: reason as any,
          message,
          wholePeer,
          perAccountDelayMs: delay,
        },
      });
      setResults(res.results as RunResult[]);
      toast.success(`Reports done — ${res.ok}/${res.total} ok, ${res.failed} failed`);
    } catch (e: any) {
      toast.error(e?.message || "Bulk report failed");
    } finally {
      setBusy(false);
    }
  };

  const okCount = results.filter((r) => r.ok).length;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Flag className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Bulk Report</h1>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs">
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-500" />
        <div>
          Use responsibly. Mass-reporting legitimate content can get accounts
          flagged or banned. Telegram may throttle repeated reports from the
          same account (FloodWait). Prefer a per-account delay of 1–3 seconds.
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Targets</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label className="text-xs">
                One per line. Accept @username, t.me/username, t.me/username/123, t.me/c/&lt;id&gt;/&lt;msg&gt;, +invite hash, numeric id.
              </Label>
              <Textarea
                rows={8}
                value={targetsText}
                onChange={(e) => setTargetsText(e.target.value)}
                placeholder={"@scam_channel\nhttps://t.me/somebot\nhttps://t.me/foochat/123"}
                className="font-mono text-xs"
              />
              <div className="text-xs text-muted-foreground">{targets.length} target(s)</div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Reason</Label>
                  <Select value={reason} onValueChange={setReason}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {REPORT_REASONS.map((r) => (
                        <SelectItem key={r} value={r}>{REASON_LABELS[r] ?? r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Per-account delay (ms)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={60000}
                    step={100}
                    value={delay}
                    onChange={(e) => setDelay(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Extra message (optional, up to 512 chars)</Label>
                <Textarea
                  rows={2}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={512}
                  placeholder="Describe the abuse (shown to Telegram moderators)"
                />
              </div>

              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={wholePeer} onCheckedChange={(v) => setWholePeer(!!v)} />
                Report the whole peer (channel/user/bot). Uncheck to include parsed message IDs in the report.
              </label>
            </CardContent>
          </Card>

          {results.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  Results — {okCount}/{results.length} ok
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-80 space-y-1 overflow-auto text-xs">
                  {results.map((r, i) => {
                    const acc = accounts.find((a) => a.id === r.accountId);
                    const who = acc?.first_name || acc?.username || acc?.phone || r.accountId.slice(0, 8);
                    return (
                      <div
                        key={i}
                        className={
                          "flex items-center gap-2 rounded border px-2 py-1 " +
                          (r.ok
                            ? "border-green-500/30 bg-green-500/5"
                            : "border-red-500/30 bg-red-500/5")
                        }
                      >
                        <span className="min-w-[110px] truncate font-medium">{who}</span>
                        <span className="min-w-[160px] truncate font-mono">{r.target}</span>
                        <span className="ml-auto text-muted-foreground">{r.message}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Accounts ({selected.size} selected)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <Button size="sm" variant="outline" onClick={toggleAll}>
                {allChecked ? "Clear all" : "Select all"}
              </Button>
              <span className="text-muted-foreground">{accounts.length} total</span>
            </div>

            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                placeholder="from"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                className="h-8 w-20 text-xs"
              />
              <span className="text-xs">–</span>
              <Input
                type="number"
                min={1}
                placeholder="to"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                className="h-8 w-20 text-xs"
              />
              <Button size="sm" variant="outline" onClick={applyRange}>Apply</Button>
            </div>

            <div className="max-h-[420px] space-y-1 overflow-auto rounded-md border border-border p-2">
              {accounts.map((a, i) => {
                const who = a.first_name || a.username || a.phone || a.id.slice(0, 8);
                return (
                  <label key={a.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent">
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggle(a.id)} />
                    <span className="w-5 text-muted-foreground">{i + 1}</span>
                    <span className="truncate">{who}</span>
                  </label>
                );
              })}
            </div>

            <Button className="w-full" disabled={!canRun} onClick={run}>
              {busy ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Reporting…</>) : (
                <><Flag className="mr-1 h-4 w-4" /> Send reports ({selected.size} × {targets.length})</>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}