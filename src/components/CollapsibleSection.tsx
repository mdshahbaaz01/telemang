import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

type Props = {
  title: ReactNode;
  storageKey: string;
  defaultOpen?: boolean;
  /** Bump this number to force the section open (e.g. from another section). */
  openSignal?: number;
  right?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
};

export function CollapsibleSection({
  title,
  storageKey,
  defaultOpen = true,
  openSignal,
  right,
  className,
  bodyClassName,
  children,
}: Props) {
  const key = `ui.collapse.${storageKey}`;
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === "0") setOpen(false);
      else if (raw === "1") setOpen(true);
    } catch {}
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(key, open ? "1" : "0"); } catch {}
  }, [open, hydrated, key]);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  return (
    <section className={`rounded-lg border border-border bg-card p-4 ${open ? "space-y-4" : ""} ${className ?? ""}`}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          <span className="text-lg font-medium">{title}</span>
        </button>
        {right}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
          title={open ? "Minimize" : "Maximize"}
        >
          {open ? "Minimize" : "Maximize"}
        </button>
      </div>
      {open && <div className={bodyClassName}>{children}</div>}
    </section>
  );
}