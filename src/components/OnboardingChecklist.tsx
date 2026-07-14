import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getOnboardingState, setOnboardingDismissed } from "@/lib/onboarding.functions";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, X, Sparkles } from "lucide-react";

export function OnboardingChecklist() {
  const qc = useQueryClient();
  const stateFn = useServerFn(getOnboardingState);
  const dismissFn = useServerFn(setOnboardingDismissed);
  const q = useQuery({
    queryKey: ["onboarding-state"],
    queryFn: () => stateFn(),
    refetchInterval: 30000,
  });
  const dismiss = useMutation({
    mutationFn: (v: boolean) => dismissFn({ data: { dismissed: v } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["onboarding-state"] }),
  });

  if (!q.data || q.data.dismissed) return null;
  if (q.data.completed >= q.data.total) return null;

  const pct = Math.round(q.data.progress * 100);

  return (
    <section
      aria-label="Getting started"
      className="mb-6 rounded-xl border border-border bg-gradient-to-br from-primary/5 via-card to-card p-4 shadow-sm"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-primary">
            <Sparkles className="h-3.5 w-3.5" /> Get started
          </div>
          <h3 className="text-base font-semibold tracking-tight">
            {q.data.completed}/{q.data.total} steps done
          </h3>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Dismiss onboarding"
          onClick={() => dismiss.mutate(true)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {q.data.steps.map((s) => (
          <li key={s.id}>
            <Link
              to={s.href ?? "/dashboard"}
              className={`flex items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:border-border hover:bg-muted/40 ${
                s.done ? "text-muted-foreground line-through" : ""
              }`}
            >
              {s.done ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <div className="truncate font-medium">{s.title}</div>
                {s.hint && !s.done && (
                  <div className="truncate text-[11px] text-muted-foreground">{s.hint}</div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}