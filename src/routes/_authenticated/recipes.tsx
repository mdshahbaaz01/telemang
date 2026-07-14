import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Play, Plus, Save, Trash2, ChefHat } from "lucide-react";
import { listRecipes, saveRecipe, deleteRecipe, type RecipeStep } from "@/lib/recipes.functions";
import { listAccounts } from "@/lib/accounts.functions";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/recipes")({
  beforeLoad: requireAdminBeforeLoad,
  component: RecipesPage,
});

const KINDS: RecipeStep["kind"][] = [
  "react",
  "vote",
  "reply",
  "broadcast",
  "edit",
  "deleteMessages",
  "forward",
  "wait",
];

const KIND_EXAMPLES: Record<RecipeStep["kind"], string> = {
  react: `{"kind":"react","source":{"chat":"@channel","msgId":123},"emoji":"🔥"}`,
  vote: `{"kind":"vote","source":{"chat":"@channel","msgId":123},"options":[0]}`,
  reply: `{"kind":"reply","source":{"chat":"@channel","msgId":123},"viaDiscussion":true,"rows":[{"accountId":"<uuid>","message":"nice!"}]}`,
  broadcast: `{"kind":"broadcast","rows":[{"accountId":"<uuid>","message":"hi","targets":["@someone"]}]}`,
  edit: `{"kind":"edit","source":{"chat":"@channel","msgId":123},"message":"new text"}`,
  deleteMessages: `{"kind":"deleteMessages","chat":"@channel","messageIds":[123]}`,
  forward: `{"kind":"forward","source":{"chat":"@channel","msgId":123},"targets":["@dest"]}`,
  wait: `{}`,
};

function newStep(): RecipeStep {
  return {
    id: crypto.randomUUID(),
    kind: "react",
    opJson: KIND_EXAMPLES.react,
    minDelay: 1,
    maxDelay: 3,
    waitAfter: 0,
    accountIds: [],
    concurrency: 5,
    note: "",
  };
}

function RecipesPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listRecipes);
  const saveFn = useServerFn(saveRecipe);
  const delFn = useServerFn(deleteRecipe);
  const accFn = useServerFn(listAccounts);

  const rQ = useQuery({ queryKey: ["recipes"], queryFn: () => listFn() });
  const aQ = useQuery({ queryKey: ["accounts"], queryFn: () => accFn() });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<RecipeStep[]>([]);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const allAccountIds = useMemo(() => (aQ.data ?? []).map((a) => a.id), [aQ.data]);

  const startNew = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setSteps([newStep()]);
    setLogs([]);
  };

  const load = (id: string) => {
    const r = (rQ.data ?? []).find((x) => x.id === id);
    if (!r) return;
    setEditingId(r.id);
    setName(r.name);
    setDescription(r.description);
    setSteps(r.steps);
    setLogs([]);
  };

  const save = async () => {
    if (!name.trim()) return toast.error("Name required");
    try {
      const res = await saveFn({ data: { id: editingId ?? undefined, name, description, steps } });
      toast.success("Recipe saved");
      setEditingId(res.id);
      qc.invalidateQueries({ queryKey: ["recipes"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete recipe?")) return;
    await delFn({ data: { id } });
    if (editingId === id) startNew();
    qc.invalidateQueries({ queryKey: ["recipes"] });
  };

  const patchStep = (idx: number, patch: Partial<RecipeStep>) =>
    setSteps((s) => s.map((step, i) => (i === idx ? { ...step, ...patch } : step)));

  const removeStep = (idx: number) => setSteps((s) => s.filter((_, i) => i !== idx));
  const addStep = () => setSteps((s) => [...s, newStep()]);

  const log = (line: string) => setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] ${line}`]);

  const runRecipe = async () => {
    if (!steps.length) return toast.error("No steps");
    setRunning(true);
    setLogs([]);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in");

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        log(`Step ${i + 1}/${steps.length}: ${step.kind}${step.note ? ` (${step.note})` : ""}`);
        if (step.kind === "wait") {
          const wait = Math.max(step.waitAfter, step.minDelay);
          log(`  waiting ${wait}s…`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        let op: any;
        try {
          op = JSON.parse(step.opJson);
          if (!op.kind) op.kind = step.kind;
        } catch (e) {
          throw new Error(`Step ${i + 1}: invalid JSON`);
        }
        const body = {
          accountIds: step.accountIds.length ? step.accountIds : allAccountIds,
          minDelay: step.minDelay,
          maxDelay: step.maxDelay,
          concurrency: step.concurrency,
          op,
        };
        const res = await fetch("/api/public/actions-stream", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!res.ok || !res.body) {
          const t = await res.text().catch(() => "");
          throw new Error(`Step ${i + 1} failed: ${res.status} ${t}`);
        }
        // Drain SSE
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: log")) log(`  ${line.slice(11)}`);
          }
        }
        log(`  step ${i + 1} done`);
        if (step.waitAfter > 0) {
          log(`  wait after ${step.waitAfter}s`);
          await new Promise((r) => setTimeout(r, step.waitAfter * 1000));
        }
      }
      log("✅ Recipe finished");
      toast.success("Recipe complete");
    } catch (e) {
      log(`❌ ${e instanceof Error ? e.message : String(e)}`);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex items-baseline justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ChefHat className="h-6 w-6" /> Recipes
        </h1>
        <Button variant="outline" size="sm" onClick={startNew}>
          <Plus className="mr-1 h-3 w-3" /> New recipe
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Chain multiple actions in one click. Each step picks its own action type, per-step delay range, and accounts.
        <code className="ml-1">op</code> JSON is validated by the stream endpoint.
      </p>

      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Saved</div>
          {(rQ.data ?? []).map((r) => (
            <button
              key={r.id}
              onClick={() => load(r.id)}
              className={`flex w-full items-center justify-between rounded border p-2 text-left text-sm ${
                editingId === r.id ? "border-primary" : ""
              }`}
            >
              <span className="truncate">{r.name}</span>
              <Trash2
                className="h-3 w-3 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(r.id);
                }}
              />
            </button>
          ))}
          {(rQ.data ?? []).length === 0 && (
            <div className="rounded border border-dashed p-3 text-center text-xs text-muted-foreground">
              No recipes yet
            </div>
          )}
        </div>

        <div className="space-y-3">
          {steps.length === 0 && !editingId && (
            <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
              Click <b>New recipe</b> to start.
            </div>
          )}
          {(steps.length > 0 || editingId) && (
            <>
              <Card>
                <CardContent className="space-y-3 p-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <Label>Name</Label>
                      <Input value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Input value={description} onChange={(e) => setDescription(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={save}>
                      <Save className="mr-1 h-3 w-3" /> Save
                    </Button>
                    <Button variant="secondary" onClick={runRecipe} disabled={running}>
                      <Play className="mr-1 h-3 w-3" /> {running ? "Running…" : "Run now"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {steps.map((s, idx) => (
                <Card key={s.id}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3">
                    <CardTitle className="text-sm">Step {idx + 1}</CardTitle>
                    <Button size="icon" variant="ghost" onClick={() => removeStep(idx)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-2 p-3 pt-0">
                    <div className="grid gap-2 md:grid-cols-5">
                      <div>
                        <Label className="text-xs">Action</Label>
                        <Select
                          value={s.kind}
                          onValueChange={(v) =>
                            patchStep(idx, {
                              kind: v as RecipeStep["kind"],
                              opJson: KIND_EXAMPLES[v as RecipeStep["kind"]],
                            })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {KINDS.map((k) => (
                              <SelectItem key={k} value={k}>
                                {k}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">Min (sec)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={s.minDelay}
                          onChange={(e) => patchStep(idx, { minDelay: Math.max(0, +e.target.value || 0) })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Max (sec)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={s.maxDelay}
                          onChange={(e) => patchStep(idx, { maxDelay: Math.max(0, +e.target.value || 0) })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Wait after (sec)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={s.waitAfter}
                          onChange={(e) => patchStep(idx, { waitAfter: Math.max(0, +e.target.value || 0) })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Concurrency</Label>
                        <Input
                          type="number"
                          min={1}
                          max={20}
                          value={s.concurrency}
                          onChange={(e) => patchStep(idx, { concurrency: Math.max(1, Math.min(20, +e.target.value || 1)) })}
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Note (optional)</Label>
                      <Input value={s.note} onChange={(e) => patchStep(idx, { note: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-xs">Accounts (empty = all)</Label>
                      <div className="mt-1 max-h-32 overflow-y-auto rounded border p-2">
                        {(aQ.data ?? []).map((a, i) => (
                          <label key={a.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
                            <Checkbox
                              checked={s.accountIds.includes(a.id)}
                              onCheckedChange={() =>
                                patchStep(idx, {
                                  accountIds: s.accountIds.includes(a.id)
                                    ? s.accountIds.filter((x) => x !== a.id)
                                    : [...s.accountIds, a.id],
                                })
                              }
                            />
                            <span className="text-muted-foreground">#{i + 1}</span>
                            <span>{a.first_name ?? a.username ?? a.phone ?? a.id.slice(0, 8)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">op JSON</Label>
                      <Textarea
                        rows={4}
                        className="font-mono text-xs"
                        value={s.opJson}
                        onChange={(e) => patchStep(idx, { opJson: e.target.value })}
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}

              <Button variant="outline" onClick={addStep}>
                <Plus className="mr-1 h-3 w-3" /> Add step
              </Button>

              {logs.length > 0 && (
                <Card>
                  <CardHeader className="p-3">
                    <CardTitle className="text-sm">Live log</CardTitle>
                  </CardHeader>
                  <CardContent className="p-3 pt-0">
                    <pre className="max-h-64 overflow-y-auto rounded bg-muted p-2 text-xs">{logs.join("\n")}</pre>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
