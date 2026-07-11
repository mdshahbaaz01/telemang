import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { listAccounts } from "@/lib/accounts.functions";
import { AdminGate } from "@/components/AdminGate";
import { TargetsPicker } from "@/components/TargetsPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Loader } from "@/components/ui/loader";
import {
  Users, UserPlus, MessagesSquare, Pencil, Copy, Mic, ListChecks, CheckCheck, Square, Play, Rocket,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/bulk-plus")({
  head: () => ({ meta: [{ title: "Bulk+ · TeleManager Pro" }] }),
  component: BulkPlusPage,
});

type Kind = "createChat" | "inviteToChat" | "dmBlast" | "editSent" | "copyClean" | "voiceNote" | "pollCreate" | "readAll";
type LogEntry = { ts: number; accountId?: string; level: "info"|"success"|"warn"|"error"; target?: string; message: string };

const KINDS: { key: Kind; label: string; desc: string; icon: any }[] = [
  { key: "createChat",   label: "Create Chat",       desc: "Each account creates its own channel/supergroup", icon: Users },
  { key: "inviteToChat", label: "Invite to Chat",    desc: "Bulk-add users to a group you own",                icon: UserPlus },
  { key: "dmBlast",      label: "DM Blast",          desc: "Scrape group members and DM them (⚠ spammy)",     icon: MessagesSquare },
  { key: "editSent",     label: "Edit Sent",         desc: "Bulk-edit messages by link list",                  icon: Pencil },
  { key: "copyClean",    label: "Copy-Clean Forward",desc: "Copy a post without \"forwarded from\" tag",       icon: Copy },
  { key: "voiceNote",    label: "Voice / Video Note",desc: "Send a voice bubble or round video note",          icon: Mic },
  { key: "pollCreate",   label: "Poll / Quiz",       desc: "Create polls or quizzes in bulk",                  icon: ListChecks },
  { key: "readAll",      label: "Read-All / Unread", desc: "Mark all dialogs as read or unread",               icon: CheckCheck },
];

function BulkPlusPage() {
  return <AdminGate><BulkPlusInner /></AdminGate>;
}

function BulkPlusInner() {
  const listAccountsFn = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAccountsFn() });
  const accounts = accountsQ.data ?? [];

  const [kind, setKind] = useState<Kind>("createChat");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [minDelay, setMinDelay] = useState(1);
  const [maxDelay, setMaxDelay] = useState(3);
  const [concurrency, setConcurrency] = useState(3);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Per-kind state
  const [createTitle, setCreateTitle] = useState("Channel #{n}");
  const [createAbout, setCreateAbout] = useState("");
  const [createUsername, setCreateUsername] = useState("");
  const [createType, setCreateType] = useState<"channel"|"supergroup">("channel");
  const [createPinned, setCreatePinned] = useState("");

  const [inviteDest, setInviteDest] = useState("");
  const [inviteUsers, setInviteUsers] = useState("");
  const [invitePerCap, setInvitePerCap] = useState(30);

  const [blastGroup, setBlastGroup] = useState("");
  const [blastMsg, setBlastMsg] = useState("");
  const [blastCap, setBlastCap] = useState(20);
  const [blastLimit, setBlastLimit] = useState(500);
  const [blastSkipBots, setBlastSkipBots] = useState(true);
  const [blastSkipDeleted, setBlastSkipDeleted] = useState(true);
  const [blastOnlyRecent, setBlastOnlyRecent] = useState(false);

  const [editLinks, setEditLinks] = useState("");
  const [editNewMsg, setEditNewMsg] = useState("");

  const [copySrc, setCopySrc] = useState("");
  const [copyTargets, setCopyTargets] = useState<string[]>([]);
  const [copySig, setCopySig] = useState("");

  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceMode, setVoiceMode] = useState<"voice"|"video">("voice");
  const [voiceTargets, setVoiceTargets] = useState<string[]>([]);

  const [pollQ, setPollQ] = useState("");
  const [pollOpts, setPollOpts] = useState("Yes\nNo");
  const [pollTargets, setPollTargets] = useState<string[]>([]);
  const [pollMulti, setPollMulti] = useState(false);
  const [pollAnon, setPollAnon] = useState(true);
  const [pollQuiz, setPollQuiz] = useState(false);
  const [pollCorrect, setPollCorrect] = useState(0);
  const [pollExplain, setPollExplain] = useState("");

  const [readScope, setReadScope] = useState<"all"|"targets">("all");
  const [readTargets, setReadTargets] = useState<string[]>([]);
  const [readMode, setReadMode] = useState<"read"|"unread">("read");

  const addLog = (l: Omit<LogEntry, "ts">) => setLogs((prev) => [{ ...l, ts: Date.now() }, ...prev].slice(0, 500));
  const clearLogs = () => setLogs([]);

  const toggleAccount = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelectedIds(new Set(accounts.map((a) => a.id)));
  const selectNone = () => setSelectedIds(new Set());

  const uploadFile = async (file: File) => {
    const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
    const path = `bulkplus/${Date.now()}-${crypto.randomUUID()}${ext}`;
    const { error } = await supabase.storage.from("action-attachments").upload(path, file, { contentType: file.type || undefined });
    if (error) throw new Error(error.message);
    return { path, filename: file.name, mimeType: file.type || undefined };
  };

  const readStream = async (res: Response) => {
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      addLog({ level: "error", message: `Stream failed: ${res.status}${t ? " — " + t : ""}` });
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const chunk of parts) {
        const evLine = chunk.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!evLine || !dataLine) continue;
        const event = evLine.slice(7).trim();
        let data: any = {}; try { data = JSON.parse(dataLine.slice(6)); } catch {}
        if (event === "start") addLog({ level: "info", message: `Run started: ${data.kind}` });
        else if (event === "log") addLog({ accountId: data.accountId, level: data.level ?? "info", target: data.target, message: data.message ?? "" });
        else if (event === "done") addLog({ accountId: data.accountId, level: data.fail ? "warn" : "info", message: `Account done — ok ${data.ok}, fail ${data.fail}` });
        else if (event === "summary") { addLog({ level: "info", message: `Total — ok ${data.ok}, fail ${data.fail}` }); (data.fail ? toast.warning : toast.success)(`Finished: ok ${data.ok}, fail ${data.fail}`); }
        else if (event === "error") addLog({ level: "error", message: data.message ?? "Server error" });
        else if (event === "aborted") addLog({ level: "warn", message: "Stopped" });
      }
    }
  };

  const buildOp = async (): Promise<any> => {
    switch (kind) {
      case "createChat": {
        if (!createTitle.trim()) throw new Error("Title pattern required");
        return { kind, chatType: createType, titlePattern: createTitle, about: createAbout, usernamePattern: createUsername, pinnedText: createPinned };
      }
      case "inviteToChat": {
        if (!inviteDest.trim()) throw new Error("Destination required");
        const users = inviteUsers.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        if (!users.length) throw new Error("Users required");
        return { kind, destination: inviteDest.trim(), users, perAccountCap: invitePerCap };
      }
      case "dmBlast": {
        if (!blastGroup.trim() || !blastMsg.trim()) throw new Error("Group link and message required");
        if (minDelay < 30) throw new Error("DM Blast requires minDelay ≥ 30s for safety");
        return { kind, sourceGroup: blastGroup.trim(), message: blastMsg, format: "plain",
          skipBots: blastSkipBots, skipDeleted: blastSkipDeleted, onlyRecent: blastOnlyRecent,
          perAccountCap: blastCap, scrapeLimit: blastLimit };
      }
      case "editSent": {
        const links = editLinks.split(/\s+/).map((s) => s.trim()).filter((s) => s.includes("t.me/"));
        if (!links.length) throw new Error("Provide at least one t.me/ link");
        if (!editNewMsg.trim()) throw new Error("New message required");
        return { kind, links, newMessage: editNewMsg, format: "plain" };
      }
      case "copyClean": {
        if (!copySrc.includes("t.me/")) throw new Error("Valid source link required");
        if (!copyTargets.length) throw new Error("Pick destinations");
        return { kind, source: copySrc.trim(), targets: copyTargets, signature: copySig };
      }
      case "voiceNote": {
        if (!voiceFile) throw new Error("Upload an audio/video file");
        if (!voiceTargets.length) throw new Error("Pick destinations");
        const file = await uploadFile(voiceFile);
        return { kind, file, mode: voiceMode, targets: voiceTargets };
      }
      case "pollCreate": {
        const options = pollOpts.split("\n").map((s) => s.trim()).filter(Boolean);
        if (!pollQ.trim() || options.length < 2) throw new Error("Question + 2+ options required");
        if (!pollTargets.length) throw new Error("Pick destinations");
        const payload: any = { kind, question: pollQ, options, targets: pollTargets, multiple: pollMulti, anonymous: pollAnon, quiz: pollQuiz };
        if (pollQuiz) { payload.correctIndex = Math.min(pollCorrect, options.length - 1); if (pollExplain) payload.explanation = pollExplain; }
        return payload;
      }
      case "readAll": {
        if (readScope === "targets" && !readTargets.length) throw new Error("Pick targets");
        if (!confirm(`Really ${readMode === "read" ? "mark as read" : "mark as unread"} on ${selectedIds.size} account(s)?`)) throw new Error("Cancelled");
        return { kind, scope: readScope, targets: readTargets, mode: readMode };
      }
    }
  };

  const run = async () => {
    if (selectedIds.size === 0) return toast.error("Pick at least one account");
    let op;
    try { op = await buildOp(); }
    catch (e) { toast.error((e as Error).message); return; }

    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return toast.error("Not signed in");

    setLogs([]); setRunning(true);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const res = await fetch("/api/public/bulk-stream", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          accountIds: Array.from(selectedIds),
          minDelay, maxDelay, concurrency, op,
        }),
        signal: ac.signal,
      });
      await readStream(res);
    } catch (e) {
      if ((e as Error).name !== "AbortError") { addLog({ level: "error", message: (e as Error).message }); toast.error((e as Error).message); }
    } finally { setRunning(false); abortRef.current = null; }
  };

  const stop = () => { abortRef.current?.abort(); setRunning(false); };

  const accountLabel = (a: any) => a.first_name || a.username || a.phone || a.id.slice(0, 8);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Rocket className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Bulk+ Power Pack</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4">
        {/* Kind selector */}
        <div className="rounded-md border border-border p-2 space-y-1 bg-card">
          {KINDS.map(({ key, label, desc, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setKind(key)}
              className={`w-full text-left rounded px-3 py-2 flex items-start gap-2 transition-colors ${kind === key ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              <Icon className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className={`text-[11px] leading-tight ${kind === key ? "opacity-90" : "text-muted-foreground"}`}>{desc}</div>
              </div>
            </button>
          ))}
        </div>

        {/* Config + accounts + logs */}
        <div className="space-y-3">
          {/* Accounts */}
          <div className="rounded-md border border-border p-3 bg-card space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Accounts ({selectedIds.size}/{accounts.length})</Label>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={selectAll}>All</Button>
                <Button size="sm" variant="ghost" onClick={selectNone}>None</Button>
              </div>
            </div>
            {accountsQ.isLoading ? <Loader /> : (
              <div className="max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1">
                {accounts.map((a, i) => (
                  <label key={a.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-muted cursor-pointer">
                    <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleAccount(a.id)} />
                    <span className="text-muted-foreground shrink-0">#{i + 1}</span>
                    <span className="truncate">{accountLabel(a)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Timing */}
          <div className="rounded-md border border-border p-3 bg-card grid grid-cols-3 gap-2">
            <div><Label className="text-xs">Min delay (s)</Label><Input type="number" min={0} value={minDelay} onChange={(e) => setMinDelay(+e.target.value || 0)} /></div>
            <div><Label className="text-xs">Max delay (s)</Label><Input type="number" min={0} value={maxDelay} onChange={(e) => setMaxDelay(+e.target.value || 0)} /></div>
            <div><Label className="text-xs">Parallel accts</Label><Input type="number" min={1} max={20} value={concurrency} onChange={(e) => setConcurrency(Math.max(1, +e.target.value || 1))} /></div>
          </div>

          {/* Per-kind config */}
          <div className="rounded-md border border-border p-3 bg-card space-y-3">
            {kind === "createChat" && (
              <>
                <div className="flex gap-2">
                  <div className="flex-1"><Label className="text-xs">Type</Label>
                    <select className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={createType} onChange={(e) => setCreateType(e.target.value as any)}>
                      <option value="channel">Broadcast Channel</option>
                      <option value="supergroup">Supergroup</option>
                    </select>
                  </div>
                </div>
                <div><Label className="text-xs">Title pattern (use {"{n}"} for number)</Label><Input value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} placeholder="e.g. My Channel #{n}" /></div>
                <div><Label className="text-xs">About</Label><Textarea rows={2} value={createAbout} onChange={(e) => setCreateAbout(e.target.value)} /></div>
                <div><Label className="text-xs">Username pattern (optional, no @, {"{n}"} supported)</Label><Input value={createUsername} onChange={(e) => setCreateUsername(e.target.value)} placeholder="e.g. mychan_{n}" /></div>
                <div><Label className="text-xs">Pinned first message (optional)</Label><Textarea rows={2} value={createPinned} onChange={(e) => setCreatePinned(e.target.value)} /></div>
              </>
            )}

            {kind === "inviteToChat" && (
              <>
                <div><Label className="text-xs">Destination (link / @username / c/id) — sender accounts must be admins</Label><Input value={inviteDest} onChange={(e) => setInviteDest(e.target.value)} placeholder="@mygroup" /></div>
                <div><Label className="text-xs">Users to invite (one per line: @username or numeric id)</Label><Textarea rows={6} value={inviteUsers} onChange={(e) => setInviteUsers(e.target.value)} /></div>
                <div><Label className="text-xs">Per-account cap (Telegram limit ~30-50/day safely)</Label><Input type="number" min={1} max={200} value={invitePerCap} onChange={(e) => setInvitePerCap(+e.target.value || 30)} /></div>
              </>
            )}

            {kind === "dmBlast" && (
              <>
                <div className="text-xs text-destructive border border-destructive/50 rounded p-2 bg-destructive/10">
                  ⚠ Cold DMs are HIGHLY spam-flagged. Use warmed accounts, min delay ≥ 30s, and small caps.
                </div>
                <div><Label className="text-xs">Source group (to scrape members)</Label><Input value={blastGroup} onChange={(e) => setBlastGroup(e.target.value)} placeholder="@somegroup or t.me/c/123.../1" /></div>
                <div><Label className="text-xs">Message (spintax OK)</Label><Textarea rows={4} value={blastMsg} onChange={(e) => setBlastMsg(e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><Label className="text-xs">Per-account cap</Label><Input type="number" value={blastCap} onChange={(e) => setBlastCap(+e.target.value || 20)} /></div>
                  <div><Label className="text-xs">Scrape limit</Label><Input type="number" value={blastLimit} onChange={(e) => setBlastLimit(+e.target.value || 500)} /></div>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={blastSkipBots} onChange={(e) => setBlastSkipBots(e.target.checked)} /> Skip bots</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={blastSkipDeleted} onChange={(e) => setBlastSkipDeleted(e.target.checked)} /> Skip deleted</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={blastOnlyRecent} onChange={(e) => setBlastOnlyRecent(e.target.checked)} /> Only online in last 7d</label>
                </div>
              </>
            )}

            {kind === "editSent" && (
              <>
                <div><Label className="text-xs">Message links (one per line)</Label><Textarea rows={5} value={editLinks} onChange={(e) => setEditLinks(e.target.value)} placeholder="https://t.me/channel/123" /></div>
                <div><Label className="text-xs">New message</Label><Textarea rows={4} value={editNewMsg} onChange={(e) => setEditNewMsg(e.target.value)} /></div>
                <p className="text-[11px] text-muted-foreground">Each selected account will attempt to edit each link (only edits ones it authored).</p>
              </>
            )}

            {kind === "copyClean" && (
              <>
                <div><Label className="text-xs">Source message link</Label><Input value={copySrc} onChange={(e) => setCopySrc(e.target.value)} placeholder="https://t.me/somechannel/45" /></div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Destinations ({copyTargets.length})</Label>
                  {accounts.length > 0 && selectedIds.size > 0 && (
                    <TargetsPicker accounts={accounts.filter((a) => selectedIds.has(a.id))} onAdd={(ts) => setCopyTargets((cur) => Array.from(new Set([...cur, ...ts])))} />
                  )}
                  {copyTargets.length > 0 && <Button size="sm" variant="ghost" onClick={() => setCopyTargets([])}>Clear</Button>}
                </div>
                <Textarea rows={3} value={copyTargets.join("\n")} onChange={(e) => setCopyTargets(e.target.value.split(/\s+/).filter(Boolean))} placeholder="@user, @channel, c/12345, or paste — one per line" />
                <div><Label className="text-xs">Signature (appended, optional)</Label><Input value={copySig} onChange={(e) => setCopySig(e.target.value)} /></div>
              </>
            )}

            {kind === "voiceNote" && (
              <>
                <div className="flex gap-2">
                  <div className="flex-1"><Label className="text-xs">Mode</Label>
                    <select className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={voiceMode} onChange={(e) => setVoiceMode(e.target.value as any)}>
                      <option value="voice">Voice note (audio, OGG/Opus for bubble)</option>
                      <option value="video">Video note (square MP4, round)</option>
                    </select>
                  </div>
                </div>
                <div><Label className="text-xs">File</Label><Input type="file" accept={voiceMode === "voice" ? "audio/*" : "video/*"} onChange={(e) => setVoiceFile(e.target.files?.[0] ?? null)} /></div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Destinations ({voiceTargets.length})</Label>
                  {accounts.length > 0 && selectedIds.size > 0 && (
                    <TargetsPicker accounts={accounts.filter((a) => selectedIds.has(a.id))} onAdd={(ts) => setVoiceTargets((cur) => Array.from(new Set([...cur, ...ts])))} />
                  )}
                  {voiceTargets.length > 0 && <Button size="sm" variant="ghost" onClick={() => setVoiceTargets([])}>Clear</Button>}
                </div>
                <Textarea rows={3} value={voiceTargets.join("\n")} onChange={(e) => setVoiceTargets(e.target.value.split(/\s+/).filter(Boolean))} />
              </>
            )}

            {kind === "pollCreate" && (
              <>
                <div><Label className="text-xs">Question</Label><Input value={pollQ} onChange={(e) => setPollQ(e.target.value)} /></div>
                <div><Label className="text-xs">Options (one per line, 2-10)</Label><Textarea rows={4} value={pollOpts} onChange={(e) => setPollOpts(e.target.value)} /></div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={pollMulti} onChange={(e) => setPollMulti(e.target.checked)} /> Multiple choice</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={pollAnon} onChange={(e) => setPollAnon(e.target.checked)} /> Anonymous</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={pollQuiz} onChange={(e) => { setPollQuiz(e.target.checked); if (e.target.checked) { setPollMulti(false); setPollAnon(true); } }} /> Quiz mode</label>
                </div>
                {pollQuiz && (
                  <>
                    <div><Label className="text-xs">Correct answer index (0-based)</Label><Input type="number" min={0} value={pollCorrect} onChange={(e) => setPollCorrect(+e.target.value || 0)} /></div>
                    <div><Label className="text-xs">Explanation (optional)</Label><Input value={pollExplain} onChange={(e) => setPollExplain(e.target.value)} /></div>
                  </>
                )}
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Destinations ({pollTargets.length})</Label>
                  {accounts.length > 0 && selectedIds.size > 0 && (
                    <TargetsPicker accounts={accounts.filter((a) => selectedIds.has(a.id))} onAdd={(ts) => setPollTargets((cur) => Array.from(new Set([...cur, ...ts])))} />
                  )}
                  {pollTargets.length > 0 && <Button size="sm" variant="ghost" onClick={() => setPollTargets([])}>Clear</Button>}
                </div>
                <Textarea rows={3} value={pollTargets.join("\n")} onChange={(e) => setPollTargets(e.target.value.split(/\s+/).filter(Boolean))} />
              </>
            )}

            {kind === "readAll" && (
              <>
                <div className="flex gap-3 text-xs">
                  <label className="flex items-center gap-1"><input type="radio" checked={readScope === "all"} onChange={() => setReadScope("all")} /> All dialogs</label>
                  <label className="flex items-center gap-1"><input type="radio" checked={readScope === "targets"} onChange={() => setReadScope("targets")} /> Only selected</label>
                </div>
                <div className="flex gap-3 text-xs">
                  <label className="flex items-center gap-1"><input type="radio" checked={readMode === "read"} onChange={() => setReadMode("read")} /> Mark read</label>
                  <label className="flex items-center gap-1"><input type="radio" checked={readMode === "unread"} onChange={() => setReadMode("unread")} /> Mark unread</label>
                </div>
                {readScope === "targets" && (
                  <>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">Targets ({readTargets.length})</Label>
                      {accounts.length > 0 && selectedIds.size > 0 && (
                        <TargetsPicker accounts={accounts.filter((a) => selectedIds.has(a.id))} onAdd={(ts) => setReadTargets((cur) => Array.from(new Set([...cur, ...ts])))} />
                      )}
                      {readTargets.length > 0 && <Button size="sm" variant="ghost" onClick={() => setReadTargets([])}>Clear</Button>}
                    </div>
                    <Textarea rows={3} value={readTargets.join("\n")} onChange={(e) => setReadTargets(e.target.value.split(/\s+/).filter(Boolean))} />
                  </>
                )}
              </>
            )}

            <div className="flex gap-2 pt-1">
              {running ? (
                <Button variant="destructive" onClick={stop}><Square className="h-4 w-4 mr-1" /> Stop</Button>
              ) : (
                <Button onClick={run} disabled={selectedIds.size === 0}><Play className="h-4 w-4 mr-1" /> Run</Button>
              )}
              <Button variant="ghost" onClick={clearLogs}>Clear logs</Button>
            </div>
          </div>

          {/* Logs */}
          <div className="rounded-md border border-border p-3 bg-card">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm">Live logs ({logs.length})</Label>
            </div>
            <div className="max-h-72 overflow-y-auto font-mono text-[11px] space-y-0.5">
              {logs.length === 0 && <div className="text-muted-foreground text-xs italic">No activity yet.</div>}
              {logs.map((l, i) => (
                <div key={i} className={
                  l.level === "error" ? "text-destructive" :
                  l.level === "warn" ? "text-yellow-500" :
                  l.level === "success" ? "text-green-500" : "text-muted-foreground"
                }>
                  <span className="opacity-60">{new Date(l.ts).toLocaleTimeString()}</span>
                  {l.accountId && <span className="opacity-60"> [{l.accountId.slice(0, 6)}]</span>}
                  {l.target && <span className="opacity-60"> {l.target}</span>}
                  {" — "}{l.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}