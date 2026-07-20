import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDown, ArrowUp } from "lucide-react";

export type PickOrder = "asc" | "desc";

/**
 * Reusable range picker for account lists.
 *
 * Applies a 1-based inclusive range against the caller's accounts list.
 * `order === "asc"` picks from top (#1..#N). `order === "desc"` picks from
 * bottom (last item = #1). The caller resolves indices → account IDs, so this
 * works for Set<string>, arrays, or any custom state shape.
 */
export function AccountRangeControls({
  total,
  onApply,
  className = "",
}: {
  total: number;
  onApply: (startIdx: number, endIdx: number, order: PickOrder) => void;
  className?: string;
}) {
  const [start, setStart] = useState<string>("1");
  const [end, setEnd] = useState<string>(String(Math.min(total || 1, 10)));
  const [order, setOrder] = useState<PickOrder>("asc");

  const apply = () => {
    if (total <= 0) return;
    const s = Math.max(1, Math.min(total, Number(start) || 1));
    const e = Math.max(s, Math.min(total, Number(end) || s));
    onApply(s, e, order);
  };

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <Input
        type="number"
        min={1}
        max={total || undefined}
        value={start}
        onChange={(e) => setStart(e.target.value)}
        className="h-8 w-16 text-xs"
        placeholder="from"
      />
      <span className="text-xs">–</span>
      <Input
        type="number"
        min={1}
        max={total || undefined}
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        className="h-8 w-16 text-xs"
        placeholder="to"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 px-2"
        onClick={() => setOrder((o) => (o === "asc" ? "desc" : "asc"))}
        title={order === "asc" ? "Top → Bottom (click to flip)" : "Bottom → Top (click to flip)"}
      >
        {order === "asc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
        <span className="ml-1 text-[10px] uppercase tracking-wide">{order === "asc" ? "T→B" : "B→T"}</span>
      </Button>
      <Button type="button" size="sm" variant="outline" className="h-8" onClick={apply}>
        Apply
      </Button>
    </div>
  );
}

/** Helper: turn (startIdx, endIdx, order) into a slice of items. */
export function pickRange<T>(items: T[], startIdx: number, endIdx: number, order: PickOrder): T[] {
  const arr = order === "asc" ? items : [...items].slice().reverse();
  return arr.slice(startIdx - 1, endIdx);
}