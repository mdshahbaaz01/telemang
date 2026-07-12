import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  listSolvers,
  saveSolver,
  saveSolversBulk,
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
import { useCaptchaAutoDetect, setCaptchaAutoDetect } from "@/lib/miniapp-proxy-url";

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
  {
    id: "twocaptcha",
    name: "2Captcha",
    url: "https://2captcha.com/enterpage",
    signup: "https://2captcha.com/auth/register",
    note: "Best coverage: image, reCAPTCHA, hCaptcha, Turnstile, GeeTest, FunCaptcha, DataDome, MTCaptcha, Amazon WAF, Capy, Lemin, and more.",
  },
  {
    id: "anticaptcha",
    name: "Anti-Captcha",
    url: "https://anti-captcha.com/clients/settings/apisetup",
    signup: "https://anti-captcha.com/clients/entrance/register",
    note: "Strong on reCAPTCHA v2/v3, hCaptcha, Turnstile, FunCaptcha, GeeTest.",
  },
  {
    id: "capsolver",
    name: "CapSolver",
    url: "https://dashboard.capsolver.com",
    signup: "https://dashboard.capsolver.com/passport/register",
    note: "Great for reCAPTCHA, hCaptcha, Turnstile, DataDome, FunCaptcha, AWS WAF.",
  },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

function CaptchaPage() {
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <header className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Captcha Solver</h1>
          <p className="text-sm text-muted-foreground">
            Pluggable adapters for 2Captcha, Anti-Captcha & CapSolver — plus built-in AI vision for
            math puzzles and button-choice captchas (no key needed).
          </p>
        </div>
        <AutoDetectToggle />
      </header>

      <Tabs defaultValue="solvers">
        <TabsList>
          <TabsTrigger value="solvers">Solvers</TabsTrigger>
          <TabsTrigger value="playground">Playground</TabsTrigger>
          <TabsTrigger value="log">Solve log</TabsTrigger>
          <TabsTrigger value="about">How it works</TabsTrigger>
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
        <TabsContent value="about" className="pt-4">
          <AboutTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AboutTab() {
  const rows: { kind: string; desc: string; who: string; auto: string }[] = [
    {
      kind: "Math / word puzzle",
      desc: "Plain-text math or word question in bot reply (e.g. \"2 + 5 = ?\", \"type the third word: apple banana cherry\").",
      who: "Built-in AI (Gemini 2.5 Flash via Lovable AI)",
      auto: "Free — no external key needed",
    },
    {
      kind: "Button-choice",
      desc: "Bot asks to tap one specific inline button out of many (e.g. \"tap 🍎\", \"choose the number 7\").",
      who: "Built-in AI (reads the question + button labels, picks the right one)",
      auto: "Free — no external key needed",
    },
    {
      kind: "Image captcha (distorted text)",
      desc: "Bot sends a photo with letters/numbers to type back.",
      who: "2Captcha → Anti-Captcha → CapSolver (priority order), then AI vision (OCR) fallback",
      auto: "External provider key + small AI credits fallback",
    },
    {
      kind: "reCAPTCHA v2 (checkbox)",
      desc: "\"I'm not a robot\" tickbox inside a mini-app iframe.",
      who: "2Captcha / Anti-Captcha / CapSolver",
      auto: "Requires a provider API key",
    },
    {
      kind: "reCAPTCHA v3 (invisible)",
      desc: "Silent score-based check on page load in a mini-app.",
      who: "2Captcha / Anti-Captcha / CapSolver",
      auto: "Requires a provider API key",
    },
    {
      kind: "hCaptcha",
      desc: "hCaptcha challenge inside a mini-app iframe.",
      who: "2Captcha / Anti-Captcha / CapSolver",
      auto: "Requires a provider API key",
    },
    {
      kind: "Cloudflare Turnstile",
      desc: "Cloudflare's invisible / managed challenge inside a mini-app.",
      who: "2Captcha / Anti-Captcha / CapSolver",
      auto: "Requires a provider API key",
    },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">How the solver works</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-3 text-muted-foreground">
          <p>
            <strong className="text-foreground">1. Detection.</strong> Inside a Telegram mini-app iframe, the proxy scans for
            captcha widgets (<code>data-sitekey</code>, reCAPTCHA / hCaptcha / Turnstile classes) and posts a
            <code> captcha_detected</code> event to the app. In Bot Flow / Chat, plain-text puzzles (math, word choice)
            and button-choice questions are read directly from the bot's reply.
          </p>
          <p>
            <strong className="text-foreground">2. Dispatch.</strong> The dispatcher picks a solver by kind:
            math &amp; button-choice go straight to the built-in AI; image / web challenges walk the enabled
            external providers in priority order, then fall back to AI vision (OCR) for images if all providers
            fail.
          </p>
          <p>
            <strong className="text-foreground">3. Injection.</strong> The solved token is posted back into the mini-app iframe
            and written into the correct hidden field (<code>g-recaptcha-response</code>, <code>h-captcha-response</code>,
            <code>cf-turnstile-response</code>) plus any registered callback is fired — the widget goes green
            without a click.
          </p>
          <p>
            <strong className="text-foreground">4. Audit.</strong> Every solve (provider, kind, latency, cost, answer preview,
            errors) is written to <em>Solve log</em>.
          </p>
          <p className="text-xs italic">
            Auto-detect is <strong>off by default</strong> (toggle in the header). Turn it on only for bots that
            actually use captchas — off means the bridge is not injected at all, keeping mini-apps light.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Supported captcha types</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Solved by</th>
                  <th className="px-3 py-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.kind} className="border-t align-top">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{r.kind}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.desc}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.who}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.auto}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Not supported (by design)</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>• FunCaptcha / Arkose Labs (custom SDK, provider-only if you enable one).</p>
          <p>• GeeTest slider (needs full browser automation).</p>
          <p>• Audio captchas (rarely used inside Telegram bots).</p>
          <p>• SMS / email OTP — those are account verification, not captchas.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function AutoDetectToggle() {
  const on = useCaptchaAutoDetect();
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2 bg-muted/30">
      <div className="text-right">
        <div className="text-xs font-medium">Auto-detect in mini-apps</div>
        <div className="text-[10px] text-muted-foreground max-w-[180px]">
          Off = skip captcha bridge for bots without captchas.
        </div>
      </div>
      <Switch checked={on} onCheckedChange={setCaptchaAutoDetect} />
    </div>
  );
}

// ---------- Solvers tab ----------

function SolversTab() {
  const qc = useQueryClient();
  const list = useServerFn(listSolvers);
  const save = useServerFn(saveSolver);
  const saveBulk = useServerFn(saveSolversBulk);
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

  type SavePayload = {
    id?: string;
    provider: ProviderId;
    label: string;
    apiKey?: string;
    enabled: boolean;
    priority: number;
  };
  const saveMut = useMutation({
    mutationFn: (payload: SavePayload) => save({ data: payload }),
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

  const [bulk, setBulk] = useState<{ twocaptcha: string; anticaptcha: string; capsolver: string }>({
    twocaptcha: "", anticaptcha: "", capsolver: "",
  });
  const bulkMut = useMutation({
    mutationFn: () => saveBulk({ data: { keys: bulk } }),
    onSuccess: (r) => {
      const saved = r.results.filter((x) => x.action !== "skipped").length;
      toast.success(saved ? `Saved ${saved} provider key${saved > 1 ? "s" : ""}` : "Nothing to save");
      setBulk({ twocaptcha: "", anticaptcha: "", capsolver: "" });
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Save all providers at once
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Paste any keys you have. Blank fields are skipped. Existing default rows are overwritten.
            You can pick which one runs from Bot Flow / Watchlists.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {PROVIDERS.map((p) => (
            <div key={p.id} className="grid gap-1">
              <div className="flex items-center justify-between">
                <Label className="text-sm">{p.name} API key</Label>
                <div className="flex gap-2 text-[11px]">
                  <a className="underline text-primary" href={p.url} target="_blank" rel="noreferrer">Get key ↗</a>
                  <a className="underline text-muted-foreground" href={p.signup} target="_blank" rel="noreferrer">Sign up</a>
                </div>
              </div>
              <Input
                type="password"
                placeholder={`Paste ${p.name} API key`}
                value={bulk[p.id as keyof typeof bulk]}
                onChange={(e) => setBulk({ ...bulk, [p.id]: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">{p.note}</p>
            </div>
          ))}
          <Button
            className="w-full"
            disabled={bulkMut.isPending || (!bulk.twocaptcha && !bulk.anticaptcha && !bulk.capsolver)}
            onClick={() => bulkMut.mutate()}
          >
            {bulkMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Save all keys
          </Button>
        </CardContent>
      </Card>

    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add / update single solver</CardTitle>
          <p className="text-xs text-muted-foreground">Use this to add a second (backup) key per provider with its own label.</p>
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
    </div>
  );
}

// ---------- Playground ----------

function PlaygroundTab() {
  const solve = useServerFn(solveCaptcha);
  const [kind, setKind] = useState<
    | "image" | "math" | "buttonChoice"
    | "recaptchaV2" | "recaptchaV3" | "hcaptcha" | "turnstile"
    | "geetest" | "geetestV4" | "funcaptcha" | "datadome" | "mtcaptcha"
    | "friendlyCaptcha" | "amazonWaf" | "capy" | "keycaptcha" | "lemin"
    | "cutcaptcha" | "atbCaptcha" | "prosopo" | "tencent"
  >("image");
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
      let r;
      if (kind === "image") r = await solve({ data: { kind, imageBase64 } });
      else if (kind === "math") r = await solve({ data: { kind, text: mathText, imageBase64: imageBase64 || undefined } });
      else if (kind === "buttonChoice") r = await solve({ data: { kind, prompt, choices } });
      else r = await solve({ data: { kind, sitekey, pageUrl } as never });
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
          {([
            "image","math","buttonChoice","recaptchaV2","recaptchaV3","hcaptcha","turnstile",
            "geetest","geetestV4","funcaptcha","datadome","mtcaptcha","friendlyCaptcha",
            "amazonWaf","capy","keycaptcha","lemin","cutcaptcha","atbCaptcha","prosopo","tencent",
          ] as const).map((k) => (
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