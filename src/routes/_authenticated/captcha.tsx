import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  listSolvers,
  saveSolver,
  deleteSolver,
  refreshSolverBalance,
  solveCaptcha,
  listSolveLog,
  clearSolveLog,
} from "@/lib/captcha.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, RefreshCcw, ShieldAlert, Trash2, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/captcha")({
  head: () => ({
    meta: [
      { title: "Captcha Solver — TeleManager Pro" },
      { name: "description", content: "Manage captcha-solving services and view solve history." },
    ],
  }),
  component: CaptchaPage,
});

const PROVIDERS = [
  { id: "twocaptcha", name: "2Captcha", url: "https://2captcha.com/enterpage" },
  { id: "anticaptcha", name: "Anti-Captcha", url: "https://anti-captcha.com/clients/settings/apisetup" },
  { id: "capsolver", name: "CapSolver", url: "https://dashboard.capsolver.com" },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

function CaptchaPage() {
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <header className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Captcha Solver</h1>
          <p className="text-sm text-muted-foreground">
            Pluggable adapters for 2Captcha, Anti-Captcha & CapSolver — plus built-in AI vision for
            math puzzles and button-choice captchas (no key needed).
          </p>
        </div>
      </header>

      <Tabs defaultValue="solvers">
        <TabsList>
          <TabsTrigger value="solvers">Solvers</TabsTrigger>
          <TabsTrigger value="playground">Playground</TabsTrigger>
          <TabsTrigger value="log">Solve log</TabsTrigger>
        </TabsList>

        <TabsContent value="solvers" className="pt-4">
          <SolversTab />
        </TabsContent>
        <TabsContent value="playground" className="pt-4">
          <PlaygroundTab />
        </TabsContent>
        <TabsContent value="log" className="pt-4">
          <LogTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- Solvers tab ----------

function SolversTab() {
  const qc = useQueryClient();
  const list = useServerFn(listSolvers);
  const save = useServerFn(saveSolver);
  const del = useServerFn(deleteSolver);
  const refresh = useServerFn(refreshSolverBalance);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["captcha-solvers"],
    queryFn: () => list(),
  });

  const [form, setForm] = useState<{
    provider: ProviderId;
    label: string;
    apiKey: string;
    priority: number;
  }>({ provider: "twocaptcha", label: "", apiKey: "", priority: 100 });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["captcha-solvers"] });

  const saveMut = useMutation({
    mutationFn: (payload: Parameters<typeof save>[0]["data"]) => save({ data: payload }),
    onSuccess: () => {
      toast.success("Solver saved");
      setForm({ provider: form.provider, label: "", apiKey: "", priority: 100 });
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => { toast.success("Removed"); invalidate(); },
  });

  const balMut = useMutation({
    mutationFn: (id: string) => refresh({ data: { id } }),
    onSuccess: (r) => { toast.success(`Balance: ${r.balance}`); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add / update solver</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Provider</Label>
              <Select value={form.provider} onValueChange={(v) => setForm({ ...form, provider: v as ProviderId })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Label (optional)</Label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="main / backup" />
            </div>
          </div>
          <div>
            <Label>API key</Label>
            <Input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="Paste key from provider dashboard"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Get it from{" "}
              <a className="underline" target="_blank" rel="noreferrer" href={PROVIDERS.find((p) => p.id === form.provider)!.url}>
                {PROVIDERS.find((p) => p.id === form.provider)!.name} dashboard
              </a>. Stored AES-GCM encrypted, never leaves the server.
            </p>
          </div>
          <div>
            <Label>Priority (lower = tried first)</Label>
            <Input
              type="number"
              min={1}
              max={9999}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 100 })}
            />
          </div>
          <Button
            className="w-full"
            disabled={!form.apiKey || saveMut.isPending}
            onClick={() =>
              saveMut.mutate({
                provider: form.provider,
                label: form.label,
                apiKey: form.apiKey,
                priority: form.priority,
                enabled: true,
              })
            }
          >
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Add solver
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured solvers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {!isLoading && rows.length === 0 && (
            <div className="text-sm text-muted-foreground">
              No solvers yet. AI vision still handles math + button-choice puzzles for free.
            </div>
          )}
          {rows.map((r) => {
            const providerName = PROVIDERS.find((p) => p.id === r.provider)?.name ?? r.provider;
            return (
              <div key={r.id} className="flex items-center gap-2 border rounded-md px-3 py-2">
                <Badge variant={r.enabled ? "default" : "secondary"}>{providerName}</Badge>
                {r.label && <span className="text-sm font-medium">{r.label}</span>}
                <span className="text-xs text-muted-foreground">pri {r.priority}</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {r.balance_cached != null ? `bal: ${r.balance_cached}` : "bal: ?"}
                </span>
                <Button size="sm" variant="ghost" onClick={() => balMut.mutate(r.id)} disabled={balMut.isPending}>
                  <RefreshCcw className="h-3 w-3" />
                </Button>
                <Switch
                  checked={r.enabled}
                  onCheckedChange={(v) =>
                    saveMut.mutate({ id: r.id, provider: r.provider as ProviderId, label: r.label, priority: r.priority, enabled: v })
                  }
                />
                <Button size="sm" variant="ghost" onClick={() => delMut.mutate(r.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Playground ----------

function PlaygroundTab() {
  const solve = useServerFn(solveCaptcha);
  const [kind, setKind] = useState<"image" | "math" | "buttonChoice" | "recaptchaV2" | "hcaptcha" | "turnstile">("image");
  const [imageBase64, setImageBase64] = useState("");
  const [mathText, setMathText] = useState("What is 12 + 7?");
  const [prompt, setPrompt] = useState("Pick the cat");
  const [choicesRaw, setChoicesRaw] = useState("Button 1\nButton 2\nButton 3");
  const [sitekey, setSitekey] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function onFile(f: File | null) {
    if (!f) return;
    const buf = await f.arrayBuffer();
    let bin = ""; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    setImageBase64(btoa(bin));
  }

  const choices = useMemo(
    () => choicesRaw.split("\n").map((s) => s.trim()).filter(Boolean).map((label, i) => ({ label: `[${i}] ${label}`, text: label })),
    [choicesRaw],
  );

  async function run() {
    setBusy(true); setResult("");
    try {
      let payload: Parameters<typeof solve>[0]["data"];
      if (kind === "image") payload = { kind, imageBase64 };
      else if (kind === "math") payload = { kind, text: mathText, imageBase64: imageBase64 || undefined };
      else if (kind === "buttonChoice") payload = { kind, prompt, choices };
      else if (kind === "recaptchaV2") payload = { kind, sitekey, pageUrl };
      else if (kind === "hcaptcha") payload = { kind, sitekey, pageUrl };
      else payload = { kind: "turnstile", sitekey, pageUrl };
      const r = await solve({ data: payload });
      setResult(JSON.stringify(r, null, 2));
    } catch (e) {
      setResult(`ERROR: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Test the solver</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 flex-wrap">
          {(["image", "math", "buttonChoice", "recaptchaV2", "hcaptcha", "turnstile"] as const).map((k) => (
            <Button key={k} variant={kind === k ? "default" : "outline"} size="sm" onClick={() => setKind(k)}>{k}</Button>
          ))}
        </div>

        {(kind === "image" || kind === "math") && (
          <div className="space-y-2">
            <Label>Image (optional for math)</Label>
            <Input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
            {imageBase64 && (
              <img src={`data:image/png;base64,${imageBase64}`} alt="captcha" className="max-h-32 border rounded" />
            )}
          </div>
        )}

        {kind === "math" && (
          <div>
            <Label>Puzzle text</Label>
            <Input value={mathText} onChange={(e) => setMathText(e.target.value)} />
          </div>
        )}

        {kind === "buttonChoice" && (
          <>
            <div><Label>Prompt</Label><Input value={prompt} onChange={(e) => setPrompt(e.target.value)} /></div>
            <div>
              <Label>Choices (one per line)</Label>
              <Textarea rows={5} value={choicesRaw} onChange={(e) => setChoicesRaw(e.target.value)} />
            </div>
          </>
        )}

        {(kind === "recaptchaV2" || kind === "hcaptcha" || kind === "turnstile") && (
          <>
            <div><Label>Sitekey</Label><Input value={sitekey} onChange={(e) => setSitekey(e.target.value)} /></div>
            <div><Label>Page URL</Label><Input value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="https://…" /></div>
          </>
        )}

        <Button onClick={run} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
          Solve
        </Button>
        {result && (
          <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-72 whitespace-pre-wrap">{result}</pre>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Log ----------

function LogTab() {
  const qc = useQueryClient();
  const list = useServerFn(listSolveLog);
  const clear = useServerFn(clearSolveLog);
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["captcha-log"], queryFn: () => list() });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Recent solves</CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => { await clear(); toast.success("Cleared"); qc.invalidateQueries({ queryKey: ["captcha-log"] }); }}
        >
          <Trash2 className="h-3 w-3 mr-1" /> Clear
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs border rounded px-2 py-1.5">
              <Badge variant={r.success ? "default" : "destructive"}>{r.kind}</Badge>
              <span className="text-muted-foreground">{r.provider}</span>
              <span className="ml-auto text-muted-foreground">{r.latency_ms}ms</span>
              {r.answer_preview && <code className="text-primary truncate max-w-[200px]">{r.answer_preview}</code>}
              {r.error && <span className="text-destructive truncate max-w-[300px]">{r.error}</span>}
              <span className="text-muted-foreground">{new Date(r.created_at).toLocaleTimeString()}</span>
            </div>
          ))}
          {!isLoading && rows.length === 0 && <div className="text-sm text-muted-foreground">No solves yet.</div>}
        </div>
      </CardContent>
    </Card>
  );
}