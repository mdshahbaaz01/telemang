import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bookmark, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { deletePreset, listPresets, savePreset } from "@/lib/presets.functions";

type Props<T> = {
  kind: string;
  currentPayload: T;
  onLoad: (payload: T) => void;
};

export function PresetBar<T>({ kind, currentPayload, onLoad }: Props<T>) {
  const list = useServerFn(listPresets);
  const save = useServerFn(savePreset);
  const del = useServerFn(deletePreset);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["presets", kind],
    queryFn: () => list({ data: { kind } }),
  });
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string>("");

  const saveMut = useMutation({
    mutationFn: () => save({ data: { kind, name: name.trim(), payload: currentPayload } }),
    onSuccess: () => {
      toast.success("Preset saved");
      setName("");
      qc.invalidateQueries({ queryKey: ["presets", kind] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("Deleted");
      setSelected("");
      qc.invalidateQueries({ queryKey: ["presets", kind] });
    },
  });

  const presets = data ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
      <Bookmark className="h-4 w-4 text-muted-foreground" />
      <Select
        value={selected}
        onValueChange={(v) => {
          setSelected(v);
          const p = presets.find((x: any) => x.id === v);
          if (p) {
            onLoad(p.payload as T);
            toast.success(`Loaded "${p.name}"`);
          }
        }}
      >
        <SelectTrigger className="h-8 w-[200px]">
          <SelectValue placeholder={presets.length ? "Load preset…" : "No presets"} />
        </SelectTrigger>
        <SelectContent>
          {presets.map((p: any) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected && (
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => delMut.mutate(selected)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
      <div className="flex-1" />
      <Input
        placeholder="Name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-8 w-[180px]"
      />
      <Button
        size="sm"
        onClick={() => name.trim() && saveMut.mutate()}
        disabled={!name.trim() || saveMut.isPending}
      >
        <Save className="h-3.5 w-3.5" /> Save preset
      </Button>
    </div>
  );
}