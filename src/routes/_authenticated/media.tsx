import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Trash2, Upload, Copy } from "lucide-react";
import { listMedia, saveMedia, updateMedia, deleteMedia } from "@/lib/media-library.functions";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/media")({
  beforeLoad: requireAdminBeforeLoad,
  component: MediaPage,
});

function MediaPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listMedia);
  const saveFn = useServerFn(saveMedia);
  const updateFn = useServerFn(updateMedia);
  const delFn = useServerFn(deleteMedia);
  const mediaQ = useQuery({ queryKey: ["media-library"], queryFn: () => listFn() });

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [search, setSearch] = useState("");

  const onUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return toast.error("Pick a file");
    if (!name.trim()) return toast.error("Give it a name");
    setBusy(true);
    try {
      const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
      const { data: sess } = await supabase.auth.getSession();
      const uid = sess.session?.user.id;
      if (!uid) throw new Error("Not signed in");
      const path = `${uid}/media/${Date.now()}-${crypto.randomUUID()}${ext}`;
      const { error } = await supabase.storage.from("action-attachments").upload(path, file, {
        contentType: file.type || undefined,
      });
      if (error) throw new Error(error.message);
      await saveFn({
        data: {
          name: name.trim(),
          path,
          filename: file.name,
          mimeType: file.type || undefined,
          sizeBytes: file.size,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          isVoice: false,
        },
      });
      toast.success("Saved to media library");
      setName("");
      setTags("");
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["media-library"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this media file?")) return;
    try {
      await delFn({ data: { id } });
      qc.invalidateQueries({ queryKey: ["media-library"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const renameTags = async (id: string, current: string[]) => {
    const next = prompt("Comma-separated tags", current.join(", "));
    if (next === null) return;
    await updateFn({ data: { id, tags: next.split(",").map((t) => t.trim()).filter(Boolean) } });
    qc.invalidateQueries({ queryKey: ["media-library"] });
  };

  const items = (mediaQ.data ?? []).filter((m) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      m.name.toLowerCase().includes(q) ||
      m.filename.toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Media Library</h1>
        <span className="text-sm text-muted-foreground">{items.length} item(s)</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload new</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Promo banner v2" />
            </div>
            <div>
              <Label>Tags (comma separated)</Label>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="promo, banner" />
            </div>
            <div>
              <Label>File</Label>
              <Input ref={fileRef} type="file" />
            </div>
          </div>
          <Button onClick={onUpload} disabled={busy}>
            <Upload className="mr-2 h-4 w-4" /> {busy ? "Uploading…" : "Save to library"}
          </Button>
        </CardContent>
      </Card>

      <div>
        <Input placeholder="Search by name, filename, or tag" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((m) => (
          <Card key={m.id}>
            <CardContent className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{m.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {m.filename} · {m.mimeType ?? "?"} · {m.sizeBytes ? Math.round(m.sizeBytes / 1024) + " KB" : ""}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.tags.map((t) => (
                    <Badge key={t} variant="secondary" className="text-[10px]">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(m.path);
                    toast.success("Path copied");
                  }}
                  title="Copy storage path"
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => renameTags(m.id, m.tags)} title="Edit tags">
                  <span className="text-xs">#</span>
                </Button>
                <Button size="icon" variant="ghost" onClick={() => remove(m.id)} title="Delete">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {items.length === 0 && (
          <div className="col-span-full rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
            No media yet. Upload files above to reuse them in broadcasts, replies, and comments.
          </div>
        )}
      </div>
    </div>
  );
}
