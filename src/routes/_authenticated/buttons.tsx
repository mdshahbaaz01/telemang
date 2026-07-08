import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Download, Heart, Settings } from "lucide-react";

export const Route = createFileRoute("/_authenticated/buttons")({
  component: ButtonsPlayground,
  head: () => ({
    meta: [
      { title: "Buttons Playground" },
      { name: "description", content: "Showcase of all button variants, sizes and states with kinetic animations." },
    ],
  }),
});

const variants = ["default", "secondary", "destructive", "outline", "ghost", "link"] as const;
const sizes = ["sm", "default", "lg"] as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function ButtonsPlayground() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Buttons Playground</h1>
        <p className="text-sm text-muted-foreground">
          Hover for lift + shadow, click for the settle animation, tab through for focus rings.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Variants</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {variants.map((v) => (
            <Row key={v} label={v}>
              <Button variant={v}>Default</Button>
              <Button variant={v}>
                <Plus /> With icon
              </Button>
              <Button variant={v} disabled>
                Disabled
              </Button>
            </Row>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Sizes</h2>
        <Row label="default variant">
          {sizes.map((s) => (
            <Button key={s} size={s}>
              Size {s}
            </Button>
          ))}
          <Button size="icon" aria-label="settings">
            <Settings />
          </Button>
        </Row>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">States</h2>
        <Row label="interactive states">
          <Button>Rest</Button>
          <Button className="hover:-translate-y-0.5 shadow-lg shadow-primary/25 -translate-y-0.5">
            Hover (forced)
          </Button>
          <Button className="translate-y-0 shadow-sm">Active (forced)</Button>
          <Button disabled>Disabled</Button>
          <Button autoFocus>Focused</Button>
        </Row>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Common actions</h2>
        <Row label="examples">
          <Button>
            <Plus /> New task
          </Button>
          <Button variant="secondary">
            <Download /> Export
          </Button>
          <Button variant="outline">
            <Heart /> Like
          </Button>
          <Button variant="destructive">
            <Trash2 /> Delete
          </Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="link">Learn more</Button>
        </Row>
      </section>
    </div>
  );
}