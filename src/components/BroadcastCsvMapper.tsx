import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { FileSpreadsheet, Save, Trash2, Upload, Plus, X, History } from "lucide-react";
import {
  saveBroadcastMapping,
  listBroadcastMappings,
  updateBroadcastMapping,
  deleteBroadcastMapping,
  type BroadcastMappingItem,
} from "@/lib/broadcast-mappings.functions";

export type MapperAccount = {
  id: string;
  phone?: string | null;
  username?: string | null;
  first_name?: string | null;
};

type Item = { message: string; target: string; accountId?: string | null };

const HEADER_ALIASES: Record<string, "message" | "target" | "account"> = {
  message: "message",
  msg: "message",
  text: "message",
  content: "message",
  body: "message",
  target: "target",
  id: "target",
  chat: "target",
  channel: "target",
  group: "target",
  username: "target",
  link: "target",
  account: "account",
  accountid: "account",
  sender: "account",
  from: "account",
};

function normalizeHeader(v: unknown) {
  return String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function parseSheet(rows: unknown[][], accounts: MapperAccount[]): Item[] {
  const clean = rows.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim()));
  if (!clean.length) return [];
  const first = clean[0]!.map(normalizeHeader);
  const mapped = first.map((h) => HEADER_ALIASES[h]);
  const hasHeader = mapped.includes("message") || mapped.includes("target");
  const body = hasHeader ? clean.slice(1) : clean;
  const msgIdx = hasHeader ? mapped.indexOf("message") : 0;
  const tgtIdx = hasHeader ? mapped.indexOf("target") : 1;
  const accIdx = hasHeader ? mapped.indexOf("account") : -1;

  const findAccount = (raw: string) => {
    const token = raw.trim().replace(/^@/, "").toLowerCase();
    if (!token) return null;
    const hit = accounts.find(
      (a) =>
        a.id.toLowerCase() === token ||
        (a.username ?? "").toLowerCase() === token ||
        (a.phone ?? "").replace(/^\+/, "") === token.replace(/^\+/, "") ||
        (a.first_name ?? "").toLowerCase() === token,
    );
    return hit?.id ?? null;
  };

  return body
    .map((r) => ({
      message: String(r[msgIdx >= 0 ? msgIdx : 0] ?? "").trim(),
      target: String(r[tgtIdx >= 0 ? tgtIdx : 1] ?? "").trim(),
      accountId: accIdx >= 0 ? findAccount(String(r[accIdx] ?? "")) : null,
    }))
    .filter((r) => r.target.length > 0);
}

export function BroadcastCsvMapper({
  accounts,
  format,
  onApply,
}: {
  accounts: MapperAccount[];
  format: string;
  /** Push the message↔target pairs into the broadcast rows editor. */
  onApply: (items: Item[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const qc = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const saveFn = useServerFn(saveBroadcastMapping);
  const listFn = useServerFn(listBroadcastMappings);
  const updateFn = useServerFn(updateBroadcastMapping);
  const deleteFn = useServerFn(deleteBroadcastMapping);
  const historyQ = useQuery({
    queryKey: ["broadcast-mappings"],
    queryFn: () => listFn(),
  });

  const handleFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]!];
      if (!sheet) throw new Error("Empty file");
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
      const parsed = parseSheet(rows as unknown[][], accounts);
      if (!parsed.length) throw new Error("No rows found — need a message and a target per line");
      setItems(parsed);
      setFileName(file.name);
      setEditingId(null);
      if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
      toast.success(`${parsed.length} message → ID pair(s) loaded`);
    } catch (e) {
      toast.error((e as Error).message || "Could not read the file");
    }
  };

  const patchItem = (i: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const save = async () => {
    const valid = items.filter((i) => i.target.trim());
    if (!valid.length) return toast.error("Nothing to save");
    if (!name.trim()) return toast.error("Give this list a name");
    setBusy(true);
    try {
      if (editingId) {
        await updateFn({ data: { id: editingId, name: name.trim(), format: format as any, items: valid } });
        toast.success("List updated");
      } else {
        const res = await saveFn({
          data: { name: name.trim(), sourceFilename: fileName, format: format as any, items: valid },
        });
        setEditingId(res.id);
        toast.success("Saved to history");
      }
      await qc.invalidateQueries({ queryKey: ["broadcast-mappings"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reuse = (row: { id: string; name: string; items: BroadcastMappingItem[]; sourceFilename: string | null }) => {
    setItems(row.items.map((i) => ({ message: i.message ?? "", target: i.target, accountId: i.accountId ?? null })));
    setName(row.name);
    setFileName(row.sourceFilename);
    setEditingId(row.id);
    setShowHistory(true);
    toast.success(`Loaded "${row.name}" — edit targets or messages, then apply`);
  };

  const remove = async (id: string) => {
    try {
      await deleteFn({ data: { id } });
      if (editingId === id) setEditingId(null);
      await qc.invalidateQueries({ queryKey: ["broadcast-mappings"] });
      toast.success("Deleted");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const history = historyQ.data ?? [];

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
        <Label className="mr-auto">CSV / Excel → one message per ID</Label>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.xlsx,.xls,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload className="mr-1 h-4 w-4" /> Upload file
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}>
          <History className="mr-1 h-4 w-4" /> History ({history.length})
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Columns: <code>message</code>, <code>target</code> and optionally <code>account</code> (username / phone / account id).
        Without a header row the 1st column is the message and the 2nd is the target. Each line becomes one row: that
        message goes only to that ID.
      </p>

      {items.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 max-w-xs"
              placeholder="List name (saved in history)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="button" size="sm" variant="outline" onClick={save} disabled={busy}>
              <Save className="mr-1 h-4 w-4" /> {editingId ? "Update in history" : "Save to history"}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const valid = items.filter((i) => i.target.trim());
                if (!valid.length) return toast.error("Nothing to apply");
                onApply(valid);
                toast.success(`${valid.length} row(s) loaded into the broadcast editor`);
              }}
            >
              Apply {items.length} row(s)
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setItems([]);
                setFileName(null);
                setEditingId(null);
              }}
            >
              <X className="mr-1 h-4 w-4" /> Clear
            </Button>
          </div>
          <div className="max-h-72 space-y-2 overflow-auto">
            {items.map((it, i) => (
              <div key={i} className="grid gap-2 rounded border border-border p-2 sm:grid-cols-[1fr_240px]">
                <Textarea
                  rows={2}
                  value={it.message}
                  placeholder="Message…"
                  onChange={(e) => patchItem(i, { message: e.target.value })}
                />
                <div className="space-y-1">
                  <Input
                    className="h-8"
                    value={it.target}
                    placeholder="@target or t.me link"
                    onChange={(e) => patchItem(i, { target: e.target.value })}
                  />
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                    value={it.accountId ?? ""}
                    onChange={(e) => patchItem(i, { accountId: e.target.value || null })}
                  >
                    <option value="">Account: use selection</option>
                    {accounts.map((a, idx) => (
                      <option key={a.id} value={a.id}>
                        #{idx + 1} — {a.first_name || a.username || a.phone}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="text-xs text-destructive underline"
                    onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    Remove row
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setItems((prev) => [...prev, { message: "", target: "", accountId: null }])}
          >
            <Plus className="mr-1 h-4 w-4" /> Add row
          </Button>
        </div>
      )}

      {showHistory && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <div className="text-xs font-medium text-muted-foreground">Saved lists</div>
          {!history.length && <p className="text-xs text-muted-foreground">Nothing saved yet.</p>}
          {history.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5 text-sm">
              <span className="truncate font-medium">{h.name}</span>
              <span className="text-xs text-muted-foreground">
                {h.items.length} row(s){h.sourceFilename ? ` · ${h.sourceFilename}` : ""}
              </span>
              <div className="ml-auto flex gap-1">
                <Button type="button" size="sm" variant="outline" onClick={() => reuse(h)}>
                  Reuse / edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onApply(h.items.map((i) => ({ message: i.message ?? "", target: i.target, accountId: i.accountId ?? null })));
                    toast.success(`${h.items.length} row(s) loaded into the broadcast editor`);
                  }}
                >
                  Apply
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove(h.id)} aria-label="Delete">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}