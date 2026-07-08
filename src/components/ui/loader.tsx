import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg";
const scales: Record<Size, number> = { sm: 0.35, md: 0.55, lg: 1 };

export function Loader({
  size = "md",
  label,
  className,
}: {
  size?: Size;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-3 py-6", className)}
      role="status"
      aria-live="polite"
    >
      <div
        className="uv-loader-wrap"
        style={{ ["--uv-loader-scale" as string]: scales[size] }}
      >
        <div className="uv-loader" />
        <div className="uv-loader" />
        <div className="uv-loader" />
      </div>
      {label ? (
        <span className="text-xs text-muted-foreground">{label}</span>
      ) : (
        <span className="sr-only">Loading</span>
      )}
    </div>
  );
}

export function PageLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <Loader size="lg" label={label} />
    </div>
  );
}