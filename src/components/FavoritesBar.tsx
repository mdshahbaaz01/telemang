import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { listFavorites, removeFavorite } from "@/lib/favorites.functions";
import { addFavorite } from "@/lib/favorites.functions";

export function FavoritesBar() {
  const list = useServerFn(listFavorites);
  const remove = useServerFn(removeFavorite);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["favorites"], queryFn: () => list() });
  const removeMut = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["favorites"] }),
  });
  const items = data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5">
      <Star className="h-3.5 w-3.5 text-yellow-500" />
      {items.map((f: any) => (
        <div
          key={f.id}
          className="group inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs hover:border-primary"
        >
          {f.href ? (
            <Link to={f.href} className="max-w-[160px] truncate">
              {f.label}
            </Link>
          ) : (
            <span className="max-w-[160px] truncate">{f.label}</span>
          )}
          <button
            type="button"
            onClick={() => {
              removeMut.mutate(f.id, {
                onSuccess: () => toast.success("Unpinned"),
              });
            }}
            className="opacity-0 transition group-hover:opacity-100"
            aria-label="Remove favorite"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function PinButton({ kind, label, href, refId }: { kind: string; label: string; href?: string; refId?: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listFavorites);
  const { data } = useQuery({ queryKey: ["favorites"], queryFn: () => list() });
  const already = (data ?? []).some(
    (f: any) => f.kind === kind && (refId ? f.ref_id === refId : f.label === label),
  );
  const add = useServerFn(addFavorite);
  const remove = useServerFn(removeFavorite);
  const mut = useMutation({
    mutationFn: async () => {
      if (already) {
        const target = (data ?? []).find((f: any) => f.kind === kind && (refId ? f.ref_id === refId : f.label === label));
        if (target) return remove({ data: { id: target.id } });
        return { ok: true };
      }
      return add({ data: { kind, label, href, ref_id: refId } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["favorites"] }),
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  return (
    <Button
      size="sm"
      variant={already ? "default" : "outline"}
      onClick={() => mut.mutate()}
      disabled={mut.isPending}
    >
      <Star className={`h-3.5 w-3.5 ${already ? "fill-current" : ""}`} />
      {already ? "Pinned" : "Pin"}
    </Button>
  );
}