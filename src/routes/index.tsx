import { createFileRoute } from "@tanstack/react-router";
import { Calculator } from "@/components/Calculator";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-3xl">
        <h1 className="mb-4 text-center text-2xl font-semibold tracking-tight text-foreground">
          Calculator
        </h1>
        <Calculator />
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Tip: use your keyboard — numbers, + − * /, Enter, Backspace, Esc
        </p>
      </div>
    </main>
  );
}
