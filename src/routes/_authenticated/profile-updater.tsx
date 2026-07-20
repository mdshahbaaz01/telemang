import { createFileRoute } from "@tanstack/react-router";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounts.functions";
import { updateProfileBulk, getAccountProfile } from "@/lib/profile.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, UserCog, RefreshCw, Plus, ChevronDown, ChevronUp, X, PlayCircle } from "lucide-react";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/profile-updater")({
  beforeLoad: requireAdminBeforeLoad,
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
  const getProfileFn = useServerFn(getAccountProfile);
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
      const list = (out as { results: typeof results }).results;
      setResults(list);
      const ok = list.filter((r) => r.ok).length;
      toast.success(`Updated ${ok}/${list.length} account(s)`);
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

      <Tabs defaultValue="single" className="space-y-4">
        <TabsList>
          <TabsTrigger value="single">Single account (edit)</TabsTrigger>
          <TabsTrigger value="bulk">Bulk update</TabsTrigger>
        </TabsList>

        <TabsContent value="single">
          <SlotsEditor accounts={accounts} getProfileFn={getProfileFn} runFn={runFn} />
        </TabsContent>

        <TabsContent value="bulk" className="space-y-4">
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
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value.replace(/^@/, ""))} placeholder="myhandle" />
              <p className="mt-1 text-xs text-muted-foreground">
                4–32 chars, must start with a letter (letters/digits/underscore). Each username is unique to one Telegram account — if you pick multiple accounts here only the first can claim it. Leave empty and untouched to skip; type spaces then clear to blank-out an existing username.
              </p>
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
        </TabsContent>
      </Tabs>
    </div>
  );
}

type AccountLite = { id: string; first_name?: string | null; phone?: string | null; username?: string | null; status?: string | null };

type GetProfileFn = (args: { data: { accountId: string } }) => Promise<{ firstName: string; lastName: string; username: string; bio: string; avatarDataUrl: string | null }>;
type RunFn = (args: { data: { accountIds: string[]; fields: Record<string, unknown> } }) => Promise<{ results: Array<{ accountId: string; ok: boolean; message: string }> }>;

type SlotHandle = { save: () => Promise<{ ok: boolean; message: string } | null> };

function SlotsEditor({
  accounts,
  getProfileFn,
  runFn,
}: {
  accounts: AccountLite[];
  getProfileFn: GetProfileFn;
  runFn: RunFn;
}) {
  const [slots, setSlots] = useState<Array<{ key: string; minimized: boolean }>>([
    { key: `s-${Date.now()}`, minimized: false },
  ]);
  const refs = useRef<Record<string, SlotHandle | null>>({});
  const [busyAll, setBusyAll] = useState(false);

  const addSlot = () =>
    setSlots((prev) => [
      ...prev.map((s) => ({ ...s, minimized: true })),
      { key: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, minimized: false },
    ]);

  const removeSlot = (key: string) => {
    delete refs.current[key];
    setSlots((prev) => prev.filter((s) => s.key !== key));
  };

  const toggleMin = (key: string) =>
    setSlots((prev) => prev.map((s) => (s.key === key ? { ...s, minimized: !s.minimized } : s)));

  const proceedAll = async () => {
    setBusyAll(true);
    try {
      const entries = slots.map((s) => refs.current[s.key]).filter(Boolean) as SlotHandle[];
      const results = await Promise.all(entries.map((h) => h.save().catch(() => null)));
      const ok = results.filter((r) => r?.ok).length;
      const total = results.length;
      if (ok === total) toast.success(`All ${total} account(s) updated`);
      else toast.error(`Updated ${ok}/${total} — check per-slot results`);
    } finally {
      setBusyAll(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={addSlot}>
          <Plus className="mr-1 h-4 w-4" /> New slot
        </Button>
        <Button size="sm" onClick={proceedAll} disabled={busyAll || slots.length === 0}>
          {busyAll ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-1 h-4 w-4" />}
          Proceed all ({slots.length})
        </Button>
        <span className="text-xs text-muted-foreground">Queue multiple accounts and run every edit in parallel.</span>
      </div>

      <div className="space-y-3">
        {slots.map((s, idx) => (
          <SlotCard
            key={s.key}
            ref={(h) => {
              refs.current[s.key] = h;
            }}
            index={idx + 1}
            minimized={s.minimized}
            onToggleMin={() => toggleMin(s.key)}
            onRemove={() => removeSlot(s.key)}
            accounts={accounts}
            getProfileFn={getProfileFn}
            runFn={runFn}
          />
        ))}
        {slots.length === 0 && (
          <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
            No slots. Click <span className="font-medium">New slot</span> to add one.
          </div>
        )}
      </div>
    </div>
  );
}

const SlotCard = forwardRef<
  SlotHandle,
  {
    index: number;
    minimized: boolean;
    onToggleMin: () => void;
    onRemove: () => void;
    accounts: AccountLite[];
    getProfileFn: GetProfileFn;
    runFn: RunFn;
  }
>(function SlotCard({ index, minimized, onToggleMin, onRemove, accounts, getProfileFn, runFn }, ref) {
  const [accountId, setAccountId] = useState<string>("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [bio, setBio] = useState("");
  const [username, setUsername] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [currentAvatar, setCurrentAvatar] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadProfile = async (id: string) => {
    if (!id) return;
    setLoading(true);
    setResult(null);
    try {
      const p = await getProfileFn({ data: { accountId: id } });
      setFirst(p.firstName);
      setLast(p.lastName);
      setUsername(p.username);
      setBio(p.bio);
      setCurrentAvatar(p.avatarDataUrl);
      setAvatarFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      toast.error(`Load failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accountId) loadProfile(accountId);
     
  }, [accountId]);

  const selected = accounts.find((a) => a.id === accountId);

  const save = async () => {
    if (!accountId) return null;
    setSaving(true);
    setResult(null);
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
          accountIds: [accountId],
          fields: {
            firstName,
            lastName,
            bio,
            username,
            ...(avatarPath ? { avatarPath } : {}),
          },
        },
      });
      const r = out.results[0];
      setResult(r ?? null);
      return r ?? null;
    } catch (e) {
      const msg = (e as Error).message;
      setResult({ ok: false, message: msg });
      return { ok: false, message: msg };
    } finally {
      setSaving(false);
    }
  };

  useImperativeHandle(ref, () => ({ save }));

  const title = accountId
    ? `#${index} · ${selected?.first_name ?? selected?.phone ?? accountId.slice(0, 8)}${selected?.username ? ` @${selected.username}` : ""}`
    : `#${index} · (no account)`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
        <CardTitle className="flex-1 truncate text-sm">
          {title}
          {result && (
            <span className={`ml-2 text-xs ${result.ok ? "text-green-600" : "text-red-600"}`}>• {result.message}</span>
          )}
        </CardTitle>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon" variant="ghost" onClick={onToggleMin} title={minimized ? "Expand" : "Minimize"}>
            {minimized ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
          <Button size="icon" variant="ghost" onClick={onRemove} title="Remove slot">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      {!minimized && (
      <CardContent className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label>Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger><SelectValue placeholder="Select an account…" /></SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.first_name ?? a.phone} {a.username ? `@${a.username}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="icon" disabled={!accountId || loading} onClick={() => loadProfile(accountId)} title="Reload current values">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {accountId && (
          <>
            <div className="flex items-center gap-3">
              <div className="h-16 w-16 overflow-hidden rounded-full border bg-muted">
                {currentAvatar ? (
                  <img src={currentAvatar} alt="avatar" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">No photo</div>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {selected?.phone ? `Phone: ${selected.phone}` : null}
                {loading ? " • Loading current values…" : ""}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div><Label>First name</Label><Input value={firstName} onChange={(e) => setFirst(e.target.value)} maxLength={64} /></div>
              <div><Label>Last name</Label><Input value={lastName} onChange={(e) => setLast(e.target.value)} maxLength={64} /></div>
            </div>
            <div>
              <Label>Bio (max 70)</Label>
              <Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={70} rows={2} />
            </div>
            <div>
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value.replace(/^@/, ""))} placeholder="myhandle" />
              <p className="mt-1 text-xs text-muted-foreground">4–32 chars, must start with a letter. Leave empty to clear the username.</p>
            </div>
            <div>
              <Label>New avatar (optional)</Label>
              <Input ref={fileRef} type="file" accept="image/*" onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)} />
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={async () => {
                  const r = await save();
                  if (r?.ok) {
                    toast.success("Profile updated");
                    loadProfile(accountId);
                  } else if (r) {
                    toast.error(r.message);
                  }
                }}
                disabled={saving || loading}
              >
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UserCog className="mr-1 h-4 w-4" />}
                Save changes
              </Button>
              {result && (
                <span className={`text-sm ${result.ok ? "text-green-600" : "text-red-600"}`}>{result.message}</span>
              )}
            </div>
          </>
        )}
      </CardContent>
      )}
    </Card>
  );
});