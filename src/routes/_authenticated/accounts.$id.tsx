import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { z } from "zod";
import {
  listDialogs,
  getHistory,
  sendMessageAs,
  markRead,
  sendReactionAs,
  deleteMessagesAs,
  pressInlineButtonAs,
  openMiniApp,
} from "@/lib/tg-viewer.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Loader2, Send, Search, Reply, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getStealthSettings } from "./stealth";
import { MiniAppDrawer, type MiniAppRequest } from "@/components/MiniAppDrawer";
import { Avatar, fmtDay, fmtDialogTime, fmtTime, initials } from "@/components/account-viewer/helpers";
import type { Dialog, InlineButton, Message } from "@/components/account-viewer/types";
import { MessageRow } from "@/components/account-viewer/MessageRow";
import { ConfirmUrlDialog } from "@/components/account-viewer/ConfirmUrlDialog";

const searchSchema = z.object({
  peer: z.string().optional(),
  solo: z
    .union([
      z.literal("1"),
      z.literal("0"),
      z.literal(1),
      z.literal(0),
      z.boolean(),
    ])
    .optional(),
});

export const Route = createFileRoute("/_authenticated/accounts/$id")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({ meta: [{ title: "Account Viewer — TeleManager Pro" }] }),
  component: AccountViewerPage,
  errorComponent: ({ error, reset }) => (
    <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-sm font-semibold">Chat failed to load</div>
      <pre className="max-w-full overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 text-[10px] text-muted-foreground">
        {String((error as Error)?.message ?? error)}
      </pre>
      <button
        onClick={() => reset()}
        className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
      >
        Retry
      </button>
    </div>
  ),
});

function AccountViewerPage() {
  const { id: accountId } = Route.useParams();
  const { peer: activePeer, solo: soloRaw } = Route.useSearch();
  const solo = soloRaw === "1" || soloRaw === 1 || soloRaw === true;
  const navigate = Route.useNavigate();

  const listDialogsFn = useServerFn(listDialogs);
  const getHistoryFn = useServerFn(getHistory);
  const sendMessageFn = useServerFn(sendMessageAs);
  const markReadFn = useServerFn(markRead);
  const sendReactionFn = useServerFn(sendReactionAs);
  const deleteMsgsFn = useServerFn(deleteMessagesAs);
  const pressBtnFn = useServerFn(pressInlineButtonAs);
  const qc = useQueryClient();

  const dialogsQ = useQuery({
    queryKey: ["tg-dialogs", accountId],
    queryFn: async () => {
      // Only download avatars on first load; subsequent refetches skip
      // photo downloads (huge speedup) and reuse the previously cached ones.
      const prev = qc.getQueryData<any>(["tg-dialogs", accountId]);
      const withPhotos = !prev;
      const res: any = await listDialogsFn({ data: { accountId, limit: 3000, withPhotos } });
      if (!withPhotos && prev) {
        const prevMap = new Map<string, string | null>(
          (prev.dialogs ?? []).map((d: any) => [d.peerKey, d.photoDataUrl]),
        );
        res.dialogs = res.dialogs.map((d: any) => ({
          ...d,
          photoDataUrl: prevMap.get(d.peerKey) ?? d.photoDataUrl ?? null,
        }));
        if (res.me) res.me.photoDataUrl = prev.me?.photoDataUrl ?? res.me.photoDataUrl ?? null;
      }
      return res;
    },
    refetchInterval: 20_000,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  const historyQ = useQuery({
    queryKey: ["tg-history", accountId, activePeer],
    queryFn: () => getHistoryFn({ data: { accountId, peerKey: activePeer!, limit: 50 } }),
    enabled: !!activePeer,
    refetchInterval: activePeer ? 3_000 : false,
    staleTime: 1_000,
    placeholderData: (prev) => prev,
  });

  const dialogs: Dialog[] = (dialogsQ.data?.dialogs ?? []) as Dialog[];
  const meId: string | undefined = dialogsQ.data?.me?.id;
  const me = dialogsQ.data?.me as
    | { id: string; name: string; username: string | null; phone: string | null; photoDataUrl: string | null }
    | undefined;
  const activeDialog = dialogs.find((d) => d.peerKey === activePeer);
  const messages: Message[] = historyQ.data?.messages ?? [];

  // Latest persistent reply-keyboard from an incoming bot message
  const latestReplyKeyboard = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.out) continue;
      const rm = m.replyMarkup;
      if (!rm || rm.kind !== "keyboard" || !rm.rows?.length) continue;
      return { msg: m, rows: rm.rows };
    }
    return null;
  }, [messages]);

  // Mark read when opening — with optional random human-like delay
  useEffect(() => {
    if (!activePeer) return;
    const s = getStealthSettings();
    if (!s.readReceiptEnabled) {
      markReadFn({ data: { accountId, peerKey: activePeer } }).catch(() => {});
      return;
    }
    const min = Math.max(0, s.readReceiptMinMs);
    const max = Math.max(min, s.readReceiptMaxMs);
    const wait = min + Math.floor(Math.random() * (max - min + 1));
    const t = setTimeout(() => {
      markReadFn({ data: { accountId, peerKey: activePeer } }).catch(() => {});
    }, wait);
    return () => clearTimeout(t);
  }, [activePeer, accountId, markReadFn]);

  const [search, setSearch] = useState("");
  const filteredDialogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...dialogs].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0);
    });
    if (!q) return sorted;
    return sorted.filter((d) => d.title.toLowerCase().includes(q) || (d.username ?? "").toLowerCase().includes(q));
  }, [dialogs, search]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const textareaRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft("");
    setReplyTo(null);
  }, [activePeer]);

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages.length, activePeer]);

  const send = async () => {
    if (!activePeer || !draft.trim() || sending) return;
    const text = draft.trim();
    setSending(true);
    // Optimistic
    const tempId = -Math.floor(Math.random() * 1e9);
    const optimistic: Message = {
      id: tempId,
      date: Date.now(),
      text,
      out: true,
      fromKey: meId ? `u:${meId}` : null,
      replyTo: replyTo?.id ?? null,
      editDate: null,
      mediaKind: null,
      photoDataUrl: null,
      reactions: [],
      views: null,
      replyMarkup: null,
    };
    qc.setQueryData(["tg-history", accountId, activePeer], (prev: any) => ({
      ...(prev ?? { messages: [], hasMore: false, oldestId: null }),
      messages: [...((prev?.messages ?? []) as Message[]), optimistic],
    }));
    setDraft("");
    setReplyTo(null);
    try {
      await sendMessageFn({ data: { accountId, peerKey: activePeer, text, replyToMsgId: replyTo?.id } });
      qc.invalidateQueries({ queryKey: ["tg-history", accountId, activePeer] });
      qc.invalidateQueries({ queryKey: ["tg-dialogs", accountId] });
    } catch (e) {
      toast.error((e as Error).message);
      // Rollback optimistic
      qc.setQueryData(["tg-history", accountId, activePeer], (prev: any) => ({
        ...(prev ?? {}),
        messages: ((prev?.messages ?? []) as Message[]).filter((m) => m.id !== tempId),
      }));
      setDraft(text);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const react = async (msg: Message, emoji: string | null) => {
    if (!activePeer) return;
    try {
      await sendReactionFn({ data: { accountId, peerKey: activePeer, msgId: msg.id, emoji } });
      qc.invalidateQueries({ queryKey: ["tg-history", accountId, activePeer] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const deleteMsg = async (msg: Message) => {
    if (!activePeer) return;
    if (!confirm("Delete this message for everyone?")) return;
    try {
      await deleteMsgsFn({ data: { accountId, peerKey: activePeer, ids: [msg.id], revoke: true } });
      qc.setQueryData(["tg-history", accountId, activePeer], (prev: any) => ({
        ...(prev ?? {}),
        messages: ((prev?.messages ?? []) as Message[]).filter((m) => m.id !== msg.id),
      }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Inline-button clicks + per-chat bot response log
  const [botLogs, setBotLogs] = useState<
    Record<string, { time: number; text: string; alert: boolean }[]>
  >({});
  const [logsOpen, setLogsOpen] = useState<Record<string, boolean>>({});
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const [pressingKey, setPressingKey] = useState<string | null>(null);
  const [miniApp, setMiniApp] = useState<MiniAppRequest | null>(null);
  const openMiniAppFn = useServerFn(openMiniApp);
  const resolveMiniApp = useMemo(
    () => (r: MiniAppRequest) =>
      openMiniAppFn({
        data: {
          accountId: r.accountId,
          peerKey: r.peerKey,
          botKey: r.botKey,
          url: r.url,
          buttonText: r.buttonText,
          simple: r.simple ?? false,
        },
      }),
    [openMiniAppFn],
  );

  const pressButton = async (msg: Message, btn: InlineButton, key: string) => {
    if (!activePeer) return;
    if (btn.kind === "url" || btn.kind === "urlAuth" || btn.kind === "webview") {
      const url = (btn as any).url as string | undefined;
      if (btn.kind === "webview") {
        setMiniApp({
          accountId,
          peerKey: activePeer,
          botKey: msg.fromKey ?? activePeer,
          url,
          buttonText: btn.text,
          simple: false,
          title: btn.text,
        });
        return;
      }
      if (!url) return toast.error("Button has no URL");
      setConfirmUrl(url);
      return;
    }
    if (btn.kind === "reply") {
      // Persistent reply-keyboard button — Telegram sends the label as a message.
      setPressingKey(key);
      try {
        await sendMessageFn({ data: { accountId, peerKey: activePeer, text: btn.text } });
        qc.invalidateQueries({ queryKey: ["tg-history", accountId, activePeer] });
        qc.invalidateQueries({ queryKey: ["tg-dialogs", accountId] });
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setPressingKey(null);
      }
      return;
    }
    if (btn.kind !== "callback") {
      toast.info("This button type isn't supported from a user account");
      return;
    }
    setPressingKey(key);
    try {
      const res = await pressBtnFn({
        data: { accountId, peerKey: activePeer, msgId: msg.id, data: btn.data },
      });
      const logKey = activePeer;
      if (res.message) {
        setBotLogs((p) => ({
          ...p,
          [logKey]: [...(p[logKey] ?? []), { time: Date.now(), text: res.message, alert: !!res.alert }],
        }));
        setLogsOpen((p) => ({ ...p, [logKey]: true }));
      } else if (res.url) {
        setConfirmUrl(res.url);
      } else {
        setBotLogs((p) => ({
          ...p,
          [logKey]: [...(p[logKey] ?? []), { time: Date.now(), text: "(no response)", alert: false }],
        }));
        setLogsOpen((p) => ({ ...p, [logKey]: true }));
      }
      // Refresh so edits / new buttons appear
      qc.invalidateQueries({ queryKey: ["tg-history", accountId, activePeer] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPressingKey(null);
    }
  };

  return (
    <div className={cn("flex flex-col", solo ? "h-screen" : "h-[calc(100vh-3.5rem)]") }>
      {!solo && (
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Link to="/owner"><Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <Avatar
          photoDataUrl={me?.photoDataUrl ?? null}
          fallback={initials(me?.name ?? "?")}
          kind="user"
          size={9}
        />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">{me?.name ?? (dialogsQ.isLoading ? "Loading…" : "Account")}</span>
          <span className="text-xs text-muted-foreground">
            {me?.username ? `@${me.username}` : me?.phone ? me.phone : accountId.slice(0, 8) + "…"} · {dialogs.length} chats
          </span>
        </div>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" onClick={() => { dialogsQ.refetch(); historyQ.refetch(); }}>
            <RefreshCw className={cn("mr-1 h-4 w-4", (dialogsQ.isFetching || historyQ.isFetching) && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>
      )}

      <div className={cn("grid min-h-0 flex-1", solo ? "grid-cols-1" : "grid-cols-[320px_1fr]")}>
        {/* Dialogs pane */}
        {!solo && (
        <aside className="flex min-h-0 flex-col border-r bg-muted/20">
          <div className="p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {dialogsQ.isLoading && (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading chats…
              </div>
            )}
            {dialogsQ.error && (
              <div className="p-4 text-sm text-red-500">{(dialogsQ.error as Error).message}</div>
            )}
            {filteredDialogs.map((d) => (
              <button
                key={d.peerKey}
                onClick={() => navigate({ search: { peer: d.peerKey }, replace: false })}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-muted",
                  activePeer === d.peerKey && "bg-muted",
                )}
              >
                <Avatar
                  photoDataUrl={d.photoDataUrl}
                  fallback={d.isSelf ? "★" : initials(d.title)}
                  kind={d.kind}
                  size={10}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-sm font-medium">{d.isSelf ? "Saved Messages" : d.title}</span>
                    {d.verified && <span className="text-xs text-blue-500">✓</span>}
                    <span className="ml-auto text-[10px] text-muted-foreground">{fmtDialogTime(d.lastMessageDate)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="truncate text-xs text-muted-foreground">{d.lastMessagePreview || "—"}</span>
                    {d.unread > 0 && (
                      <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                        {d.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>
        )}

        {/* Chat pane */}
        <section className="flex min-h-0 flex-col">
          {!activePeer && (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Select a chat to view messages
            </div>
          )}
          {activePeer && (
            <>
              <div className="flex items-center gap-3 border-b px-4 py-2">
                <Avatar
                  photoDataUrl={activeDialog?.photoDataUrl ?? null}
                  fallback={initials(activeDialog?.title ?? "?")}
                  kind={activeDialog?.kind ?? "user"}
                  size={9}
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{activeDialog?.isSelf ? "Saved Messages" : activeDialog?.title ?? activePeer}</div>
                  <div className="text-xs text-muted-foreground">
                    {activeDialog?.kind === "channel" ? "Channel" : activeDialog?.kind === "group" ? "Group" : "User"}
                    {activeDialog?.username ? ` · @${activeDialog.username}` : ""}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {historyQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { historyQ.refetch(); dialogsQ.refetch(); }}
                    title="Refresh chat"
                  >
                    <RefreshCw className={cn("h-4 w-4", historyQ.isFetching && "animate-spin")} />
                  </Button>
                </div>
              </div>

              <div ref={scrollerRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3">
                {historyQ.isLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
                  </div>
                )}
                {messages.map((m, i) => {
                  const prev = messages[i - 1];
                  const showDay = !prev || new Date(prev.date).toDateString() !== new Date(m.date).toDateString();
                  const parentReply = m.replyTo ? messages.find((x) => x.id === m.replyTo) : null;
                  return (
                    <div key={m.id}>
                      {showDay && (
                        <div className="my-3 flex items-center justify-center">
                          <span className="rounded-full bg-muted px-3 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{fmtDay(m.date)}</span>
                        </div>
                      )}
                      <MessageRow
                        msg={m}
                        parentReply={parentReply ?? null}
                        onReply={() => setReplyTo(m)}
                        onReact={react}
                        onDelete={deleteMsg}
                        isOwn={m.out}
                        canModify={m.out}
                        onPressButton={pressButton}
                        pressingKey={pressingKey}
                      />
                    </div>
                  );
                })}
                {activePeer && (botLogs[activePeer]?.length ?? 0) > 0 && (
                  <div className="sticky bottom-0 rounded-md border border-dashed border-primary/40 bg-primary/5 p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <button
                        className="text-[10px] uppercase tracking-wide text-muted-foreground hover:underline"
                        onClick={() =>
                          setLogsOpen((p) => ({ ...p, [activePeer]: !p[activePeer] }))
                        }
                      >
                        {logsOpen[activePeer] ? "Hide" : "Show"} bot responses (
                        {botLogs[activePeer].length})
                      </button>
                      <button
                        className="text-[10px] text-muted-foreground hover:underline"
                        onClick={() => setBotLogs((p) => ({ ...p, [activePeer]: [] }))}
                      >
                        Clear
                      </button>
                    </div>
                    {logsOpen[activePeer] && (
                      <div className="space-y-1">
                        {botLogs[activePeer].map((l, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <span className="mt-0.5 text-[10px] text-muted-foreground">
                              {fmtTime(l.time)}
                            </span>
                            <span className={l.alert ? "text-amber-600" : ""}>{l.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!historyQ.isLoading && messages.length === 0 && (
                  <div className="pt-6 text-center text-sm text-muted-foreground">No messages yet</div>
                )}
              </div>

              {replyTo && (
                <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-2 text-xs">
                  <Reply className="h-4 w-4 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">Replying to</div>
                    <div className="truncate text-muted-foreground">{replyTo.text || "[media]"}</div>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => setReplyTo(null)}><X className="h-3 w-3" /></Button>
                </div>
              )}

              {latestReplyKeyboard && (
                <div className="border-t bg-muted/30 p-2">
                  <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>Bot keyboard</span>
                  </div>
                  <div className="space-y-1">
                    {latestReplyKeyboard.rows.map((row, ri) => (
                      <div key={ri} className="flex flex-wrap gap-1">
                        {row.map((btn, ci) => {
                          const key = `kb:${latestReplyKeyboard.msg.id}:${ri}:${ci}`;
                          const busy = pressingKey === key;
                          return (
                            <button
                              key={ci}
                              type="button"
                              disabled={busy}
                              onClick={() => pressButton(latestReplyKeyboard.msg, btn, key)}
                              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-xs hover:bg-primary/20 disabled:opacity-60"
                            >
                              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                              <span className="truncate">{btn.text}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 border-t p-3">
                <Input
                  ref={textareaRef as any}
                  placeholder={activeDialog?.isChannel && !activeDialog.isSelf ? "Send message to channel…" : "Message"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  disabled={sending}
                  autoFocus
                />
                <Button onClick={send} disabled={!draft.trim() || sending}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>

      {confirmUrl && <ConfirmUrlDialog url={confirmUrl} accountId={accountId} onClose={() => setConfirmUrl(null)} />}

      <MiniAppDrawer
        open={!!miniApp}
        request={miniApp}
        onClose={() => setMiniApp(null)}
        resolver={resolveMiniApp}
      />
    </div>
  );
}
