import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { updateProfileBulk } from "@/lib/profile.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, UserCog } from "lucide-react";

export const Route = createFileRoute("/_authenticated/profile-updater")({
  head: () => ({
    meta: [
      { title: "Profile Updater — TeleManager Pro" },
      { name: "description", content: "Bulk update Telegram account profiles: name, bio, username, avatar." },
    ],
  }),
  component: ProfileUpdater,
});

function ProfileUpdater() {
  const listFn = useServerFn(listAccounts);
  const runFn = useServerFn(updateProfileBulk);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listFn() });
  const accounts = accountsQ.data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [bio, setBio] = useState("");
  const [username, setUsername] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ accountId: string; ok: boolean; message: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const allChecked = selected.size > 0 && selected.size === accounts.length;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(accounts.map((a) => a.id)));
  const toggle = (id: string) => {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };

  const canRun = useMemo(
    () => selected.size > 0 && (firstName || lastName || bio || username || avatarFile),
    [selected, firstName, lastName, bio, username, avatarFile],
  );

  const run = async () => {
    setBusy(true);
    setResults([]);
    try {
      let avatarPath: string | undefined;
      if (avatarFile) {
        const { data: userRes } = await supabase.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in");
        const key = `${uid}/avatar-${Date.now()}-${avatarFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const { error } = await supabase.storage.from("action-attachments").upload(key, avatarFile, {
          contentType: avatarFile.type || "image/jpeg",
          upsert: false,
        });
        if (error) throw new Error(`Avatar upload failed: ${error.message}`);
        avatarPath = key;
      }
      const out = await runFn({
        data: {
          accountIds: Array.from(selected),
          fields: {
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
            ...(bio ? { bio } : {}),
            ...(username !== "" ? { username } : {}),
            ...(avatarPath ? { avatarPath } : {}),
          },
        },
      });
      setResults(out as any);
      const ok = (out as any[]).filter((r) => r.ok).length;
      toast.success(`Updated ${ok}/${(out as any[]).length} account(s)`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <UserCog className="h-5 w-5" />
        <h1 className="text-xl font-semibold">Profile Updater</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Bulk-update first/last name, bio, username, and avatar across selected accounts. Leave a field empty to skip it.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Fields</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>First name</Label><Input value={firstName} onChange={(e) => setFirst(e.target.value)} maxLength={64} /></div>
              <div><Label>Last name</Label><Input value={lastName} onChange={(e) => setLast(e.target.value)} maxLength={64} /></div>
            </div>
            <div>
              <Label>Bio (max 70)</Label>
              <Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={70} rows={2} />
            </div>
            <div>
              <Label>Username (blank = clear, leave field untouched to skip)</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value.replace(/^@/, ""))} placeholder="myhandle" />
              <p className="mt-1 text-xs text-muted-foreground">Only unique usernames succeed; per-account result shown below.</p>
            </div>
            <div>
              <Label>Avatar</Label>
              <Input ref={fileRef} type="file" accept="image/*" onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Accounts ({selected.size}/{accounts.length})</CardTitle>
            <Button size="sm" variant="ghost" onClick={toggleAll}>{allChecked ? "Unselect all" : "Select all"}</Button>
          </CardHeader>
          <CardContent className="max-h-96 space-y-1 overflow-y-auto">
            {accountsQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted">
                <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggle(a.id)} />
                <span className="text-sm">{a.first_name ?? a.phone} {a.username ? `@${a.username}` : ""}</span>
                <span className="ml-auto text-xs text-muted-foreground">{a.status}</span>
              </label>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={run} disabled={!canRun || busy}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UserCog className="mr-1 h-4 w-4" />}
          Update {selected.size} account{selected.size === 1 ? "" : "s"}
        </Button>
      </div>

      {results.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Results</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {results.map((r, i) => {
              const acc = accounts.find((a) => a.id === r.accountId);
              return (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className={`inline-block h-2 w-2 rounded-full ${r.ok ? "bg-green-500" : "bg-red-500"}`} />
                  <span className="font-medium">{acc?.first_name ?? r.accountId.slice(0, 8)}</span>
                  <span className="text-muted-foreground">{r.message}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}