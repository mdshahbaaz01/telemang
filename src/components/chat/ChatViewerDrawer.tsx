import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { chatViewer, useChatViewer } from "./chat-viewer-store";
import { previewChat, loadChatHistory, loadChatMembers, sendQuickReply, joinChatTarget, leaveChatTarget, cancelJoinRequest } from "@/lib/chat-viewer.functions";
import { pressInlineButtonAs } from "@/lib/tg-viewer.functions";
import { recordInlineButtonClick } from "@/lib/button-clicks.functions";
import { listAccounts } from "@/lib/accounts.functions";
import { ExternalLink, Send, Users, Info, MessageCircle, Loader2, Image as ImageIcon, Video, FileText, Music, Link as LinkIcon, LogIn, LogOut, UserPlus, ArrowLeft, Lock, XCircle } from "lucide-react";
import { toast } from "sonner";

const IST_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const IST_DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function tgDeepLink(target: string) {
  const c = target.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
  if (/^c\/\d+/.test(c)) {
    const id = c.split("/")[1];
    return `tg://privatepost?channel=${id}`;
  }
  return `tg://resolve?domain=${encodeURIComponent(c.split("/")[0])}`;
}

function mediaIcon(kind: string | null) {
  const cls = "h-3.5 w-3.5";
  if (!kind) return null;
  if (kind === "photo") return <ImageIcon className={cls} />;
  if (kind === "video") return <Video className={cls} />;
  if (kind === "audio") return <Music className={cls} />;
  if (kind === "document") return <FileText className={cls} />;
  if (kind === "link") return <LinkIcon className={cls} />;
  return <FileText className={cls} />;
}

export function ChatViewerHost() {
  const state = useChatViewer();
  return (
    <Sheet open={state.open} onOpenChange={(o) => { if (!o) chatViewer.close(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col">
        {state.open && state.target ? (
          <ChatViewerInner target={state.target} accountId={state.accountId} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ChatViewerInner({ target, accountId }: { target: string; accountId: string | null }) {
  const previewFn = useServerFn(previewChat);
  const historyFn = useServerFn(loadChatHistory);
  const membersFn = useServerFn(loadChatMembers);
  const replyFn = useServerFn(sendQuickReply);
  const accountsFn = useServerFn(listAccounts);
  const pressFn = useServerFn(pressInlineButtonAs);
  const recordClickFn = useServerFn(recordInlineButtonClick);
  const joinFn = useServerFn(joinChatTarget);
  const leaveFn = useServerFn(leaveChatTarget);
  const cancelReqFn = useServerFn(cancelJoinRequest);

  const [activeAccountId, setActiveAccountId] = useState<string | null>(accountId);
  useEffect(() => setActiveAccountId(accountId), [accountId, target]);

  const accountsQ = useQuery({ queryKey: ["viewer-accounts"], queryFn: () => accountsFn(), staleTime: 60_000 });

  const previewQ = useQuery({
    queryKey: ["chat-preview", target, activeAccountId],
    queryFn: () => previewFn({ data: { target, accountId: activeAccountId ?? undefined } }),
    staleTime: 60_000,
    retry: false,
  });

  // Adopt the account the server picked
  useEffect(() => {
    if (!activeAccountId && previewQ.data?.accountId) setActiveAccountId(previewQ.data.accountId);
  }, [previewQ.data?.accountId, activeAccountId]);

  const [olderMessages, setOlderMessages] = useState<any[]>([]);
  useEffect(() => setOlderMessages([]), [target, activeAccountId]);

  const allMessages = useMemo(() => [...olderMessages, ...(previewQ.data?.messages ?? [])], [olderMessages, previewQ.data]);

  const loadMoreMut = useMutation({
    mutationFn: async () => {
      const first = allMessages[0];
      if (!first || !previewQ.data?.accountId) return [];
      return historyFn({ data: { target, accountId: previewQ.data.accountId, beforeMsgId: first.id, limit: 40 } });
    },
    onSuccess: (rows) => {
      if (Array.isArray(rows) && rows.length) setOlderMessages((prev) => [...rows, ...prev]);
      else toast.info("No more messages");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const [tab, setTab] = useState<"messages" | "info" | "members">("messages");
  const membersQ = useQuery({
    queryKey: ["chat-members", target, activeAccountId, tab],
    queryFn: () => membersFn({ data: { target, accountId: activeAccountId!, limit: 100 } }),
    enabled: !!activeAccountId && tab === "members",
    retry: false,
  });

  const [reply, setReply] = useState("");
  const [replyToId, setReplyToId] = useState<number | null>(null);
  const [pressingKey, setPressingKey] = useState<string | null>(null);

  const peerKey = previewQ.data?.peerKey ?? null;

  async function handlePressButton(msg: any, btn: any, key: string) {
    if (!activeAccountId) { toast.error("Pick an account first"); return; }
    const commonLog = {
      accountId: activeAccountId,
      peerKey: peerKey ?? null,
      target,
      msgId: msg?.id ?? null,
      buttonLabel: btn?.text ?? null,
      source: "viewer" as const,
    };
    try {
      if (!btn || typeof btn !== "object" || !btn.kind) {
        toast.error("Malformed button — cannot press");
        return;
      }
      if (btn.kind === "url" || btn.kind === "urlAuth") {
        recordClickFn({
          data: { ...commonLog, buttonKind: btn.kind, resultStatus: "opened", resultUrl: btn.url ?? null },
        }).catch(() => {});
        window.open(btn.url, "_blank", "noopener");
        return;
      }
      if (btn.kind === "webview") {
        recordClickFn({
          data: { ...commonLog, buttonKind: "webview", resultStatus: btn.url ? "opened" : "ok", resultUrl: btn.url ?? null },
        }).catch(() => {});
        if (btn.url) window.open(btn.url, "_blank", "noopener");
        else toast.info("WebApp button — open from the Telegram app");
        return;
      }
      if (btn.kind === "reply") {
        setPressingKey(key);
        await replyFn({ data: { target, accountId: activeAccountId, message: btn.text } });
        recordClickFn({
          data: { ...commonLog, buttonKind: "reply", resultStatus: "ok", resultMessage: btn.text },
        }).catch(() => {});
        toast.success("Sent");
        previewQ.refetch();
        return;
      }
      if (btn.kind === "requestPhone") {
        setPressingKey(key);
        await replyFn({ data: { target, accountId: activeAccountId, message: btn.text, shareContact: true } });
        recordClickFn({
          data: { ...commonLog, buttonKind: "requestPhone", resultStatus: "ok", resultMessage: "profile shared" },
        }).catch(() => {});
        toast.success("Profile shared");
        previewQ.refetch();
        return;
      }
      if (btn.kind === "callback") {
        if (!peerKey) { toast.error("Chat not fully loaded yet"); return; }
        setPressingKey(key);
        const res = await pressFn({
          data: {
            accountId: activeAccountId,
            peerKey,
            msgId: msg.id,
            data: btn.data,
            buttonLabel: btn.text ?? undefined,
          },
        });
        if (res?.url) window.open(res.url, "_blank", "noopener");
        if (res?.message) (res.alert ? toast.warning : toast.success)(res.message);
        else if (!res?.url) toast.success("Sent");
        previewQ.refetch();
        return;
      }
      toast.info(`${btn.kind} button not supported here`);
    } catch (e) {
      const msgTxt = (e as Error)?.message || "Button press failed";
      recordClickFn({
        data: { ...commonLog, buttonKind: btn?.kind ?? "unknown", resultStatus: "error", resultMessage: msgTxt },
      }).catch(() => {});
      toast.error(msgTxt);
    } finally {
      setPressingKey(null);
    }
  }
  const replyMut = useMutation({
    mutationFn: async () => {
      if (!activeAccountId || !reply.trim()) throw new Error("Type a message first");
      return replyFn({
        data: {
          target,
          accountId: activeAccountId,
          message: reply.trim(),
          replyToMsgId: replyToId ?? undefined,
        },
      });
    },
    onSuccess: () => {
      toast.success("Sent");
      setReply("");
      setReplyToId(null);
      previewQ.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const chat = previewQ.data?.chat;
  const err = previewQ.error as Error | null;

  const joinMut = useMutation({
    mutationFn: async () => {
      if (!activeAccountId) throw new Error("Pick an account first");
      return joinFn({ data: { target, accountId: activeAccountId } });
    },
    onSuccess: (res) => {
      if (res?.status === "requested") toast.success("Join request sent — waiting for approval");
      else if (res?.status === "already") toast.info("Already a member");
      else toast.success("Joined");
      previewQ.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const leaveMut = useMutation({
    mutationFn: async () => {
      if (!activeAccountId) throw new Error("Pick an account first");
      return leaveFn({ data: { target, accountId: activeAccountId } });
    },
    onSuccess: () => {
      toast.success("Left chat");
      previewQ.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const cancelReqMut = useMutation({
    mutationFn: async () => {
      if (!activeAccountId) throw new Error("Pick an account first");
      return cancelReqFn({ data: { target, accountId: activeAccountId } });
    },
    onSuccess: (res: any) => {
      toast.success(res?.note ?? "Join request cancelled");
      previewQ.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const groups = useMemo(() => {
    const g: Record<string, typeof allMessages> = {};
    for (const m of allMessages) {
      const d = m.date ? IST_DATE_FMT.format(new Date(m.date)) : "—";
      (g[d] ||= []).push(m);
    }
    return g;
  }, [allMessages]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [previewQ.data]);

  return (
    <>
      <SheetHeader className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            title="Back"
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={() => chatViewer.close()}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold text-sm shrink-0">
            {(chat?.title ?? target).slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-left">{chat?.title ?? target}</SheetTitle>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground truncate">
              {chat?.kind && <span className="uppercase tracking-wide">{chat.kind}</span>}
              {chat?.username && <span>· @{chat.username}</span>}
              {chat?.memberCount != null && <span>· {chat.memberCount.toLocaleString()} members</span>}
              {chat?.id != null && <span className="font-mono">· {chat.id}</span>}
            </div>
          </div>
          <a
            href={tgDeepLink(target)}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-primary shrink-0"
            title="Open in Telegram"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
        {chat && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(chat as any)?.needsJoin ? (
              <Button
                size="sm"
                className="h-8"
                disabled={!activeAccountId || joinMut.isPending}
                onClick={() => joinMut.mutate()}
                title={(chat as any)?.requestNeeded ? "Send join request" : "Join this chat"}
              >
                {joinMut.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (chat as any)?.requestNeeded ? (
                  <UserPlus className="mr-1 h-4 w-4" />
                ) : (
                  <LogIn className="mr-1 h-4 w-4" />
                )}
                {(chat as any)?.requestNeeded ? "Request to join" : "Join"}
              </Button>
            ) : null}
            {(chat as any)?.needsJoin && (chat as any)?.requestNeeded && (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!activeAccountId || cancelReqMut.isPending}
                onClick={() => {
                  if (confirm("Cancel your pending join request?")) cancelReqMut.mutate();
                }}
                title="Withdraw pending join request"
              >
                {cancelReqMut.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="mr-1 h-4 w-4" />
                )}
                Cancel request
              </Button>
            )}
            {!(chat as any)?.needsJoin && (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!activeAccountId || leaveMut.isPending}
                onClick={() => {
                  if (confirm("Leave this chat with the selected account?")) leaveMut.mutate();
                }}
                title="Leave this chat"
              >
                {leaveMut.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="mr-1 h-4 w-4" />
                )}
                Leave
              </Button>
            )}
            {!activeAccountId && (
              <span className="text-[11px] text-muted-foreground">Pick an account first</span>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">Viewing as:</label>
          <select
            className="rounded border border-border bg-background px-2 py-1 text-xs flex-1 min-w-0"
            value={activeAccountId ?? previewQ.data?.accountId ?? ""}
            onChange={(e) => setActiveAccountId(e.target.value || null)}
          >
            <option value="">Auto (healthiest)</option>
            {(accountsQ.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.first_name || a.username || a.phone} {a.status !== "active" ? `· ${a.status}` : ""}
              </option>
            ))}
          </select>
        </div>
      </SheetHeader>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-4 mt-3 grid grid-cols-3 w-auto">
          <TabsTrigger value="messages"><MessageCircle className="h-3.5 w-3.5 mr-1" />Messages</TabsTrigger>
          <TabsTrigger value="info"><Info className="h-3.5 w-3.5 mr-1" />Info</TabsTrigger>
          <TabsTrigger value="members"><Users className="h-3.5 w-3.5 mr-1" />Members</TabsTrigger>
        </TabsList>

        <TabsContent value="messages" className="flex-1 flex flex-col min-h-0 m-0">
          {previewQ.isLoading ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading chat…
            </div>
          ) : err ? (
            <div className="flex-1 p-6 text-sm text-destructive">Failed to load: {err.message}</div>
          ) : (chat as any)?.needsJoin ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="h-7 w-7 text-primary" />
              </div>
              <div className="text-lg font-semibold">{chat?.title}</div>
              <div className="text-xs text-muted-foreground">
                {chat?.memberCount != null ? `${chat.memberCount.toLocaleString()} members` : chat?.kind}
              </div>
              {chat?.about && (
                <p className="max-w-sm whitespace-pre-wrap text-sm text-muted-foreground">{chat.about}</p>
              )}
              <p className="max-w-sm text-xs text-muted-foreground">
                {(chat as any)?.requestNeeded
                  ? "This chat requires admin approval. Send a join request to be added."
                  : "You are not a member of this chat. Join to see messages."}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => chatViewer.close()}>
                  <ArrowLeft className="mr-1 h-4 w-4" /> Back
                </Button>
                <Button
                  size="sm"
                  disabled={!activeAccountId || joinMut.isPending}
                  onClick={() => joinMut.mutate()}
                >
                  {joinMut.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (chat as any)?.requestNeeded ? (
                    <UserPlus className="mr-1 h-4 w-4" />
                  ) : (
                    <LogIn className="mr-1 h-4 w-4" />
                  )}
                  {(chat as any)?.requestNeeded ? "Send join request" : "Join"}
                </Button>
              </div>
              {!activeAccountId && (
                <p className="text-[11px] text-destructive">Pick an account above to join.</p>
              )}
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 bg-muted/30">
                <div className="text-center">
                  <button
                    className="text-xs text-primary underline disabled:opacity-50"
                    disabled={loadMoreMut.isPending || !allMessages.length}
                    onClick={() => loadMoreMut.mutate()}
                  >
                    {loadMoreMut.isPending ? "Loading…" : "↑ Load older"}
                  </button>
                </div>
                {Object.entries(groups).map(([date, msgs]) => (
                  <div key={date} className="space-y-1.5">
                    <div className="text-center">
                      <span className="inline-block rounded-full bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm">
                        {date}
                      </span>
                    </div>
                    {msgs.map((m) => (
                      <MessageBubble
                        key={m.id}
                        m={m}
                        onReply={() => setReplyToId(m.id)}
                        onPressButton={(btn, key) => handlePressButton(m, btn, key)}
                        pressingKey={pressingKey}
                      />
                    ))}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              <div className="border-t border-border p-3 space-y-2">
                {replyToId && (
                  <div className="flex items-center gap-2 text-xs bg-muted rounded px-2 py-1">
                    <span className="text-muted-foreground">Replying to #{replyToId}</span>
                    <button onClick={() => setReplyToId(null)} className="ml-auto text-destructive">×</button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <Textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={activeAccountId ? "Reply from this account…" : "Pick an account to reply"}
                    className="min-h-[42px] max-h-32 resize-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        replyMut.mutate();
                      }
                    }}
                  />
                  <Button
                    size="icon"
                    disabled={!reply.trim() || !activeAccountId || replyMut.isPending}
                    onClick={() => replyMut.mutate()}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="info" className="flex-1 overflow-y-auto p-4 space-y-3 text-sm m-0">
          {!chat ? (
            <p className="text-muted-foreground">No info yet.</p>
          ) : (
            <>
              <InfoRow label="Title" value={chat.title} />
              <InfoRow label="Type" value={chat.kind} />
              <InfoRow label="ID" value={chat.id != null ? String(chat.id) : "—"} mono />
              <InfoRow label="Username" value={chat.username ? `@${chat.username}` : "—"} />
              <InfoRow label="Members" value={chat.memberCount != null ? chat.memberCount.toLocaleString() : "—"} />
              <InfoRow label="You" value={chat.isCreator ? "Creator" : chat.isAdmin ? "Admin" : chat.isParticipant ? "Member" : "Not joined"} />
              {chat.inviteLink && <InfoRow label="Invite" value={chat.inviteLink} link />}
              {chat.about && (
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">About</div>
                  <div className="whitespace-pre-wrap text-sm">{chat.about}</div>
                </div>
              )}
              <div className="pt-2 flex flex-wrap gap-2">
                {(chat as any).needsJoin ? (
                  <Button
                    size="sm"
                    disabled={!activeAccountId || joinMut.isPending}
                    onClick={() => joinMut.mutate()}
                  >
                    {joinMut.isPending ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (chat as any).requestNeeded ? (
                      <UserPlus className="mr-1 h-4 w-4" />
                    ) : (
                      <LogIn className="mr-1 h-4 w-4" />
                    )}
                    {(chat as any).requestNeeded ? "Send join request" : "Join"}
                  </Button>
                ) : chat.isParticipant && (chat.kind === "channel" || chat.kind === "megagroup" || chat.kind === "group") ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!activeAccountId || leaveMut.isPending}
                    onClick={() => {
                      if (confirm(`Leave ${chat.title}?`)) leaveMut.mutate();
                    }}
                  >
                    {leaveMut.isPending ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <LogOut className="mr-1 h-4 w-4" />
                    )}
                    Leave
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="members" className="flex-1 overflow-y-auto p-3 m-0">
          {membersQ.isLoading && (
            <div className="flex items-center justify-center text-sm text-muted-foreground py-6">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading members…
            </div>
          )}
          {(membersQ.data as any)?.error && (
            <p className="text-sm text-destructive">{(membersQ.data as any).error}</p>
          )}
          {membersQ.data?.participants?.length ? (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground mb-2">
                {membersQ.data.total.toLocaleString()} total · showing {membersQ.data.participants.length}
              </div>
              {membersQ.data.participants.map((p: any, i: number) => (
                <div key={`${p.userId}-${i}`} className="flex items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-xs">
                  <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center text-primary text-[10px] font-semibold shrink-0">
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{p.name}</div>
                    {p.username && <div className="truncate text-muted-foreground">@{p.username}</div>}
                  </div>
                  {p.isCreator && <span className="text-[10px] uppercase text-primary">Creator</span>}
                  {p.isAdmin && !p.isCreator && <span className="text-[10px] uppercase text-primary/70">Admin</span>}
                  {p.isBot && <span className="text-[10px] uppercase text-muted-foreground">Bot</span>}
                  {p.username && (
                    <button
                      className="text-primary hover:underline text-[11px]"
                      onClick={() => chatViewer.open(p.username!, activeAccountId ?? undefined)}
                    >
                      Open
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : membersQ.isSuccess && !(membersQ.data as any)?.error ? (
            <p className="text-sm text-muted-foreground">No members visible.</p>
          ) : null}
        </TabsContent>
      </Tabs>
    </>
  );
}

function InfoRow({ label, value, mono, link }: { label: string; value: string; mono?: boolean; link?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <div className="text-xs uppercase tracking-wide text-muted-foreground w-20 shrink-0">{label}</div>
      {link ? (
        <a href={value} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate">{value}</a>
      ) : (
        <div className={"truncate " + (mono ? "font-mono text-xs" : "")}>{value}</div>
      )}
    </div>
  );
}

function MessageBubble({ m, onReply, onPressButton, pressingKey }: { m: any; onReply: () => void; onPressButton: (btn: any, key: string) => void; pressingKey: string | null }) {
  const time = m.date ? IST_FMT.format(new Date(m.date)) : "";
  if (m.isService) {
    return (
      <div className="text-center">
        <span className="inline-block rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm">
          {m.text || "system event"}
        </span>
      </div>
    );
  }
  return (
    <div className="group flex flex-col max-w-[85%]">
      <div
        className="rounded-2xl bg-card border border-border px-3 py-1.5 shadow-sm hover:border-primary/40 cursor-pointer"
        onClick={onReply}
        title="Click to reply"
      >
        {m.fromName && <div className="text-[11px] font-semibold text-primary">{m.fromName}</div>}
        {m.media && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground my-1">
            {mediaIcon(m.media)} <span className="uppercase text-[10px]">{m.media}</span>
          </div>
        )}
        {m.text && <div className="whitespace-pre-wrap text-sm break-words">{m.text}</div>}
        {m.replyMarkup && (m.replyMarkup.kind === "inline" || m.replyMarkup.kind === "keyboard") && m.replyMarkup.rows?.length > 0 && (
          <div className="mt-1.5 space-y-1" onClick={(e) => e.stopPropagation()}>
            {m.replyMarkup.rows.map((row: any[], ri: number) => (
              <div key={ri} className="flex flex-wrap gap-1">
                {row.map((btn, ci) => {
                  const key = `${m.id}:${ri}:${ci}`;
                  const busy = pressingKey === key;
                  const clickable = ["callback","url","urlAuth","webview","reply","requestPhone"].includes(btn.kind);
                  const title = btn.kind === "url" || btn.kind === "urlAuth"
                    ? `Opens: ${btn.url}`
                    : btn.kind === "callback" ? "Callback"
                    : btn.kind === "webview" ? "WebApp"
                    : btn.kind === "requestPhone" ? "Shares this account profile/contact"
                    : btn.kind === "reply" ? `Sends: ${btn.text}`
                    : `${btn.kind} (not supported)`;
                  return (
                    <button
                      key={ci}
                      type="button"
                      title={title}
                      disabled={!clickable || busy}
                      onClick={() => onPressButton(btn, key)}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${clickable ? "border-primary/40 bg-primary/10 hover:bg-primary/20" : "cursor-not-allowed border-border bg-muted opacity-60"}`}
                    >
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      {(btn.kind === "url" || btn.kind === "urlAuth") && <ExternalLink className="h-3 w-3" />}
                      <span className="max-w-[16rem] truncate">{btn.kind === "requestPhone" ? "🔐 " : ""}{btn.text}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
          <span>#{m.id}</span>
          <span>{time}</span>
          {m.views != null && <span>· 👁 {m.views}</span>}
          {m.edited && <span>· edited</span>}
          {m.reactions?.length ? (
            <span className="ml-1">
              {m.reactions.map((r: any) => `${r.emoji} ${r.count}`).join(" ")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}