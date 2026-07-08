import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export type PasteAccount = {
  id: string;
  phone?: string | null;
  username?: string | null;
  first_name?: string | null;
};

type Props = {
  accounts: PasteAccount[];
  /** Called with the set of matched account ids. */
  onSelect: (ids: string[]) => void;
  className?: string;
};

/**
 * Small optional textarea for pasting phone numbers / usernames / account ids
 * (any separator). Matches against `accounts` and calls `onSelect` with the
 * matching account ids so the caller can merge them into its selection state.
 */
export function AccountIdPaste({ accounts, onSelect, className }: Props) {
  const [value, setValue] = useState("");

  const apply = () => {
    const tokens = value
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean);
    if (!tokens.length) {
      toast.error("Paste at least one identifier");
      return;
    }
    const matched = new Set<string>();
    let misses = 0;
    for (const tok of tokens) {
      const digits = tok.replace(/\D/g, "");
      const hit = accounts.find((a) => {
        const phone = (a.phone ?? "").replace(/\D/g, "");
        return (
          a.id.toLowerCase() === tok ||
          (a.username ?? "").toLowerCase() === tok ||
          (a.first_name ?? "").toLowerCase() === tok ||
          (digits.length > 0 && phone.endsWith(digits))
        );
      });
      if (hit) matched.add(hit.id);
      else misses++;
    }
    onSelect(Array.from(matched));
    toast.success(
      `Selected ${matched.size} account${matched.size === 1 ? "" : "s"}` +
        (misses ? ` · ${misses} not found` : ""),
    );
  };

  return (
    <div className={`rounded-md border border-dashed border-border p-3 space-y-2 ${className ?? ""}`}>
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        Paste IDs to auto-select (optional)
      </Label>
      <Textarea
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste phone numbers, usernames, or account IDs — one per line or comma/space separated"
        className="font-mono text-xs"
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={apply}>
          Select matching
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setValue("")}>
          Clear
        </Button>
      </div>
    </div>
  );
}