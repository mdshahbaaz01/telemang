import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  listFeatureRequests,
  createFeatureRequest,
  toggleVoteFeatureRequest,
  deleteFeatureRequest,
  ownerUpdateFeatureRequest,
  type FeatureRequestRow,
} from "@/lib/feedback.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader } from "@/components/ui/loader";
import { toast } from "sonner";
import { ArrowUp, Bug, Lightbulb, Sparkles, Trash2 } from "lucide-react";
import { useMyRole } from "@/components/AdminGate";

export const Route = createFileRoute("/_authenticated/feedback")({
  component: FeedbackPage,
});

type Cat = "feature" | "bug" | "improvement";
type Status = FeatureRequestRow["status"];

const STATUS_TONE: Record<Status, string> = {
  open: "bg-muted text-foreground",
  planned: "bg-blue-500/10 text-blue-600 border-blue-500/30",
  in_progress: "bg-primary/10 text-primary border-primary/30",
  done: "bg-green-500/10 text-green-600 border-green-500/30",
  declined: "bg-destructive/10 text-destructive border-destructive/30",
};

function FeedbackPage() {
  const qc = useQueryClient();
  const me = useMyRole();
  const listFn = useServerFn(listFeatureRequests);
  const createFn = useServerFn(createFeatureRequest);
  const voteFn = useServerFn(toggleVoteFeatureRequest);
  const delFn = useServerFn(deleteFeatureRequest);
  const ownerUpdateFn = useServerFn(ownerUpdateFeatureRequest);

  const q = useQuery({ queryKey: ["feature-requests"], queryFn: () => listFn() });
  const [status, setStatus] = useState<Status | "all">("all");
  const [cat, setCat] = useState<Cat | "all">("all");
  const [sort, setSort] = useState<"votes" | "new">("votes");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["feature-requests"] });

  const vote = useMutation({
    mutationFn: (v: { id: string; vote: boolean }) => voteFn({ data: v }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["feature-requests"] });
      const prev = qc.getQueryData<FeatureRequestRow[]>(["feature-requests"]);
      qc.setQueryData<FeatureRequestRow[]>(["feature-requests"], (old) =>
        (old ?? []).map((r) =>
          r.id === v.id
            ? { ...r, voted: v.vote, votes_count: r.votes_count + (v.vote ? 1 : -1) }
            : r,
        ),
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["feature-requests"], ctx.prev);
      toast.error((e as Error).message);
    },
  });

  const filtered = useMemo(() => {
    const rows = q.data ?? [];
    const f = rows.filter(
      (r) => (status === "all" || r.status === status) && (cat === "all" || r.category === cat),
    );
    return [...f].sort((a, b) =>
      sort === "votes"
        ? b.votes_count - a.votes_count || (a.created_at < b.created_at ? 1 : -1)
        : a.created_at < b.created_at
          ? 1
          : -1,
    );
  }, [q.data, status, cat, sort]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
        <p className="text-sm text-muted-foreground">
          Suggest features, report bugs, and upvote what matters most. The owner triages requests from here.
        </p>
      </header>

      <CreateForm
        onSubmit={async (title, description, category) => {
          try {
            await createFn({ data: { title, description, category } });
            toast.success("Submitted");
            invalidate();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />

      <div className="mt-6 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <Chips
          label="Status"
          options={[
            ["all", "All"],
            ["open", "Open"],
            ["planned", "Planned"],
            ["in_progress", "In progress"],
            ["done", "Done"],
            ["declined", "Declined"],
          ]}
          value={status}
          onChange={(v) => setStatus(v as Status | "all")}
        />
        <Chips
          label="Category"
          options={[
            ["all", "All"],
            ["feature", "Feature"],
            ["improvement", "Improvement"],
            ["bug", "Bug"],
          ]}
          value={cat}
          onChange={(v) => setCat(v as Cat | "all")}
        />
        <Chips
          label="Sort"
          options={[
            ["votes", "Top voted"],
            ["new", "Newest"],
          ]}
          value={sort}
          onChange={(v) => setSort(v as "votes" | "new")}
        />
      </div>

      <section className="mt-4 space-y-2">
        {q.isLoading ? (
          <Loader size="sm" />
        ) : filtered.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Nothing here yet. Be the first to post.
          </p>
        ) : (
          filtered.map((r) => (
            <article
              key={r.id}
              className="flex gap-3 rounded-lg border border-border bg-card p-3"
            >
              <button
                onClick={() => vote.mutate({ id: r.id, vote: !r.voted })}
                aria-label={r.voted ? "Remove vote" : "Upvote"}
                className={`flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-md border transition ${
                  r.voted
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:border-primary/50 hover:bg-muted/40"
                }`}
              >
                <ArrowUp className="h-4 w-4" />
                <span className="mt-0.5 text-sm font-semibold">{r.votes_count}</span>
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CatIcon c={r.category} />
                  <h3 className="min-w-0 truncate text-sm font-semibold">{r.title}</h3>
                  <Badge className={`border ${STATUS_TONE[r.status]}`}>{r.status.replace("_", " ")}</Badge>
                  {r.priority !== "med" && (
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {r.priority}
                    </Badge>
                  )}
                  {r.mine && <Badge variant="secondary" className="text-[10px]">mine</Badge>}
                </div>
                {r.description && (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{r.description}</p>
                )}
                {r.owner_note && (
                  <div className="mt-2 rounded border border-primary/30 bg-primary/5 p-2 text-xs">
                    <span className="font-semibold text-primary">Owner: </span>
                    {r.owner_note}
                  </div>
                )}
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {r.email || "—"} · {new Date(r.created_at).toLocaleString()}
                </div>
                {(me.data?.isAdmin || r.mine) && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(r.mine || me.data?.isAdmin) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          if (!confirm("Delete this request?")) return;
                          try {
                            await delFn({ data: { id: r.id } });
                            toast.success("Deleted");
                            invalidate();
                          } catch (e) {
                            toast.error((e as Error).message);
                          }
                        }}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                      </Button>
                    )}
                  </div>
                )}
                {me.data?.isAdmin && (
                  <OwnerTriage
                    row={r}
                    onSave={async (patch) => {
                      try {
                        await ownerUpdateFn({ data: { id: r.id, ...patch } });
                        toast.success("Updated");
                        invalidate();
                      } catch (e) {
                        toast.error((e as Error).message);
                      }
                    }}
                  />
                )}
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}

function Chips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="mr-1 font-medium text-muted-foreground">{label}:</span>
      {options.map(([v, l]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded-full border px-2 py-0.5 transition ${
            value === v
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:bg-muted/40"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function CatIcon({ c }: { c: Cat }) {
  const Icon = c === "bug" ? Bug : c === "improvement" ? Sparkles : Lightbulb;
  return <Icon className="h-3.5 w-3.5 text-muted-foreground" />;
}

function CreateForm({
  onSubmit,
}: {
  onSubmit: (title: string, description: string | undefined, category: Cat) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [cat, setCat] = useState<Cat>("feature");

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="w-full rounded-md border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/40"
        >
          Suggest a feature, report a bug…
        </button>
      ) : (
        <div className="space-y-2">
          <Input
            autoFocus
            placeholder="Short title (max 140 chars)"
            maxLength={140}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            placeholder="Optional detail — what problem does this solve?"
            maxLength={4000}
            rows={3}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Chips
              label="Category"
              options={[
                ["feature", "Feature"],
                ["improvement", "Improvement"],
                ["bug", "Bug"],
              ]}
              value={cat}
              onChange={(v) => setCat(v as Cat)}
            />
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={title.trim().length < 3}
                onClick={() => {
                  onSubmit(title.trim(), desc.trim() || undefined, cat);
                  setTitle("");
                  setDesc("");
                  setOpen(false);
                }}
              >
                Submit
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OwnerTriage({
  row,
  onSave,
}: {
  row: FeatureRequestRow;
  onSave: (patch: {
    status?: Status;
    priority?: FeatureRequestRow["priority"];
    owner_note?: string | null;
  }) => void;
}) {
  const [note, setNote] = useState(row.owner_note ?? "");
  return (
    <details className="mt-2 rounded border border-border/60 bg-muted/20 p-2 text-xs">
      <summary className="cursor-pointer select-none font-medium">Owner triage</summary>
      <div className="mt-2 space-y-2">
        <Chips
          label="Status"
          options={[
            ["open", "Open"],
            ["planned", "Planned"],
            ["in_progress", "In progress"],
            ["done", "Done"],
            ["declined", "Declined"],
          ]}
          value={row.status}
          onChange={(v) => onSave({ status: v as Status })}
        />
        <Chips
          label="Priority"
          options={[
            ["low", "Low"],
            ["med", "Med"],
            ["high", "High"],
          ]}
          value={row.priority}
          onChange={(v) => onSave({ priority: v as FeatureRequestRow["priority"] })}
        />
        <div className="flex gap-2">
          <Input
            className="h-8"
            placeholder="Owner note (visible to everyone)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
          />
          <Button size="sm" onClick={() => onSave({ owner_note: note.trim() || null })}>
            Save note
          </Button>
        </div>
      </div>
    </details>
  );
}