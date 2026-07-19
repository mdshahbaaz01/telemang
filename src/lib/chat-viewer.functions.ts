import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { serializeReplyMarkup } from "./tg-viewer.functions";
import { markPeerRead } from "./telegram-read-helper.server";

function computePeerKey(entity: any): string | null {
  if (!entity) return null;
  const cn = String(entity.className ?? "");
  const id = entity.id != null ? String(entity.id) : null;
  if (!id) return null;
  if (cn === "Channel" || cn === "ChannelForbidden") return `c:${id}`;
  if (cn === "Chat" || cn === "ChatForbidden") return `g:${id}`;
  if (cn === "User") return `u:${id}`;
  if (entity.broadcast || entity.megagroup) return `c:${id}`;
  if (entity.bot || entity.firstName != null) return `u:${id}`;
  return null;
}

const targetSchema = z.object({
  target: z.string().min(1).max(200),
  accountId: z.string().uuid().optional(),
});

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  if (typeof v === "object" && v && "toString" in v) return Number((v as { toString: () => string }).toString());
  return null;
}

async function pickHealthyAccountId(supabase: any, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("telegram_accounts")
    .select("id, status, paused_until, updated_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(20);
  const now = Date.now();
  const usable = (data ?? []).find((a: any) => !a.paused_until || new Date(a.paused_until).getTime() < now);
  return usable ? (usable.id as string) : (data?.[0]?.id ?? null);
}

async function resolveTargetEntity(client: any, Api: any, t: string) {
  const cleaned = t.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
  if (/^c\/\d+/.test(cleaned)) {
    const raw = cleaned.split("/")[1];
    const { default: bigInt } = await import("big-integer");
    try {
      return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
    } catch {
      return await client.getEntity(`https://t.me/${cleaned}`);
    }
  }
  return await client.getEntity(cleaned);
}

function extractInviteHash(t: string): string | null {
  const cleaned = t.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "");
  const m = cleaned.match(/^(?:joinchat\/|\+)([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function entityKind(entity: any): "channel" | "megagroup" | "group" | "user" | "bot" | "unknown" {
  if (!entity) return "unknown";
  if (entity.className === "Channel" || entity.broadcast) {
    if (entity.megagroup || entity.gigagroup) return "megagroup";
    return "channel";
  }
  if (entity.className === "Chat" || entity.chatId) return "group";
  if (entity.bot) return "bot";
  if (entity.className === "User" || entity.userId != null) return "user";
  return "unknown";
}

function displayName(entity: any): string {
  if (!entity) return "Unknown";
  const first = entity.firstName ?? "";
  const last = entity.lastName ?? "";
  const full = `${first} ${last}`.trim();
  return entity.title ?? full ?? entity.username ?? "Unknown";
}

export const previewChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => targetSchema.parse(d))
  .handler(async ({ data, context }) => {
    const accountId = data.accountId ?? (await pickHealthyAccountId(context.supabase, context.userId));
    if (!accountId) throw new Error("No active account available. Log in an account first.");

    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");

    const client = await openClientForAccount(context.supabase, accountId, { requireOwnerId: context.userId });
    try {
      // Invite-hash flow (private / public-with-request). Peek before joining
      // so we can show a Join / Send-Request card in the UI, exactly like the
      // real Telegram app.
      const inviteHash = extractInviteHash(data.target);
      if (inviteHash) {
        let info: any = null;
        try {
          info = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
        } catch (e) {
          throw new Error(`Invite link invalid or expired: ${(e as Error).message}`);
        }
        const cn = String(info?.className ?? "");
        // Already a member → info.chat is the real chat; fall through to full render.
        if (cn === "ChatInviteAlready" && info?.chat) {
          const entity = info.chat;
          return await buildFullPreview({ client, Api, entity, accountId, target: data.target });
        }
        // Not a member → return preview-only card.
        const requestNeeded = !!info?.requestNeeded;
        const title = String(info?.title ?? "Private channel");
        const memberCount = toNum(info?.participantsCount) ?? null;
        const isChannel = !!info?.channel;
        const isMegagroup = !!info?.megagroup;
        const isBroadcast = !!info?.broadcast;
        return {
          accountId,
          peerKey: null,
          chat: {
            id: null,
            kind: isChannel && isBroadcast ? "channel" : isMegagroup ? "megagroup" : "group",
            title,
            username: null,
            memberCount,
            about: info?.about ?? null,
            inviteLink: data.target,
            isCreator: false,
            isAdmin: false,
            isParticipant: false,
            target: data.target,
            needsJoin: true,
            requestNeeded,
            inviteHash,
          },
          messages: [],
        };
      }

      const entity = await resolveTargetEntity(client, Api, data.target);
      return await buildFullPreview({ client, Api, entity, accountId, target: data.target });
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

async function buildFullPreview(args: {
  client: any;
  Api: any;
  entity: any;
  accountId: string;
  target: string;
}) {
  const { client, Api, entity, accountId, target } = args;
  const kind = entityKind(entity);
  const title = displayName(entity);
  const username = (entity as any).username ?? null;
  const entityId = toNum((entity as any).id);

  let memberCount: number | null = null;
  let about: string | null = null;
  let inviteLink: string | null = null;
  let isCreator = false;
  let isAdmin = false;
  let isParticipant = true;

  if (kind === "channel" || kind === "megagroup") {
    try {
      const full: any = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
      memberCount = toNum(full?.fullChat?.participantsCount) ?? null;
      about = full?.fullChat?.about ?? null;
      inviteLink = full?.fullChat?.exportedInvite?.link ?? null;
    } catch {}
    isCreator = !!(entity as any).creator;
    isAdmin = !!(entity as any).adminRights;
    isParticipant = !(entity as any).left;
  } else if (kind === "group") {
    memberCount = toNum((entity as any).participantsCount) ?? null;
  } else if (kind === "user" || kind === "bot") {
    try {
      const full: any = await client.invoke(new Api.users.GetFullUser({ id: entity }));
      about = full?.fullUser?.about ?? null;
    } catch {}
  }

  let messages: any[] = [];
  if (isParticipant || kind === "user" || kind === "bot" || username) {
    try {
      const history: any = await client.invoke(
        new Api.messages.GetHistory({ peer: entity, limit: 30, offsetId: 0, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: 0 as any }),
      );
      const msgs = Array.isArray(history?.messages) ? history.messages : [];
      const users = new Map<string, any>();
      for (const u of history?.users ?? []) users.set(String(u.id), u);
      const chats = new Map<string, any>();
      for (const c of history?.chats ?? []) chats.set(String(c.id), c);
      messages = msgs
        .filter((m: any) => m.className === "Message" || m.className === "MessageService")
        .map((m: any) => {
          const fromId = m.fromId?.userId ?? m.fromId?.channelId ?? m.fromId?.chatId ?? null;
          const from = fromId ? users.get(String(fromId)) ?? chats.get(String(fromId)) : null;
          const media = m.media
            ? m.media.className === "MessageMediaPhoto"
              ? "photo"
              : m.media.className === "MessageMediaDocument"
              ? m.media.document?.mimeType?.startsWith("video/")
                ? "video"
                : m.media.document?.mimeType?.startsWith("audio/")
                ? "audio"
                : "document"
              : m.media.className === "MessageMediaWebPage"
              ? "link"
              : "other"
            : null;
          return {
            id: Number(m.id),
            date: m.date ? new Date(Number(m.date) * 1000).toISOString() : null,
            text: (m.message as string | undefined) ?? (m.action?.className ?? ""),
            fromName: from ? displayName(from) : null,
            fromUsername: (from?.username as string | null) ?? null,
            fromId: fromId ? toNum(fromId) : null,
            media,
            views: toNum(m.views),
            edited: !!m.editDate,
            reactions: (m.reactions?.results ?? []).map((r: any) => ({
              emoji: r.reaction?.emoticon ?? r.reaction?.className ?? "?",
              count: Number(r.count ?? 0),
            })),
            isService: m.className === "MessageService",
            replyMarkup: serializeReplyMarkup(m.replyMarkup),
          };
        })
        .reverse();
    } catch {
      messages = [];
    }
  }

  const needsJoin = !isParticipant && (kind === "channel" || kind === "megagroup" || kind === "group");
  return {
    accountId,
    peerKey: computePeerKey(entity),
    chat: {
      id: entityId,
      kind,
      title,
      username,
      memberCount,
      about,
      inviteLink,
      isCreator,
      isAdmin,
      isParticipant,
      target,
      needsJoin,
      requestNeeded: false,
      inviteHash: null as string | null,
    },
    messages,
  };
}

// Join a public username or invite-hash target from the chat viewer. Uses the
// verified helper so we get the same idempotent / dedup behaviour as bot flow.
export const joinChatTarget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ target: z.string().min(1).max(200), accountId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const { joinTelegramTargetVerified } = await import("./telegram-join-helper.server");
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    try {
      const res = await joinTelegramTargetVerified({
        client,
        Api,
        target: data.target,
        publicInviteFallback: true,
      });
      return { status: res.status, message: res.message, path: res.path };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// Leave a chat/channel from the viewer (matches real-Telegram "Leave").
export const leaveChatTarget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ target: z.string().min(1).max(200), accountId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    try {
      const entity = await resolveTargetEntity(client, Api, data.target);
      const cn = String((entity as any).className ?? "");
      if (cn.includes("Channel")) {
        await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
      } else if (cn === "Chat") {
        const me = await client.getMe(true);
        await client.invoke(new Api.messages.DeleteChatUser({ chatId: (entity as any).id, userId: me }));
      } else {
        throw new Error("This chat cannot be left");
      }
      return { ok: true };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// Cancel a pending join request for approval-required channels.
// Uses messages.HideChatJoinRequest with the caller's own userId + approved=false.
export const cancelJoinRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ target: z.string().min(1).max(200), accountId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    try {
      // Resolve entity — for invite-hash links, fall back to CheckChatInvite.
      let entity: any = null;
      try {
        entity = await resolveTargetEntity(client, Api, data.target);
      } catch {
        const hash = extractInviteHash(data.target);
        if (!hash) throw new Error("Could not resolve chat");
        const info: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
        entity = info?.chat ?? info?.channel ?? null;
        if (!entity) throw new Error("Chat not resolvable from invite link");
      }
      const me = await client.getMe(true);
      try {
        await client.invoke(
          new Api.messages.HideChatJoinRequest({ peer: entity, userId: me, approved: false }),
        );
      } catch (err: any) {
        const msg = String(err?.message ?? err ?? "");
        if (/HIDE_REQUESTER_MISSING|USER_NOT_PARTICIPANT|PEER_ID_INVALID/i.test(msg)) {
          return { ok: true, note: "No pending request found" };
        }
        throw err;
      }
      return { ok: true };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

export const loadChatHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        target: z.string().min(1).max(200),
        accountId: z.string().uuid(),
        beforeMsgId: z.number().int().positive(),
        limit: z.number().int().min(1).max(80).default(40),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    try {
      const entity = await resolveTargetEntity(client, Api, data.target);
      const history: any = await client.invoke(
        new Api.messages.GetHistory({
          peer: entity,
          limit: data.limit,
          offsetId: data.beforeMsgId,
          offsetDate: 0,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: 0 as any,
        }),
      );
      const msgs = Array.isArray(history?.messages) ? history.messages : [];
      const users = new Map<string, any>();
      for (const u of history?.users ?? []) users.set(String(u.id), u);
      const chats = new Map<string, any>();
      for (const c of history?.chats ?? []) chats.set(String(c.id), c);
      return msgs
        .filter((m: any) => m.className === "Message" || m.className === "MessageService")
        .map((m: any) => {
          const fromId = m.fromId?.userId ?? m.fromId?.channelId ?? m.fromId?.chatId ?? null;
          const from = fromId ? users.get(String(fromId)) ?? chats.get(String(fromId)) : null;
          return {
            id: Number(m.id),
            date: m.date ? new Date(Number(m.date) * 1000).toISOString() : null,
            text: (m.message as string | undefined) ?? (m.action?.className ?? ""),
            fromName: from ? displayName(from) : null,
            fromUsername: (from?.username as string | null) ?? null,
            fromId: fromId ? toNum(fromId) : null,
            media: m.media ? "media" : null,
            views: toNum(m.views),
            edited: !!m.editDate,
            reactions: [] as { emoji: string; count: number }[],
            isService: m.className === "MessageService",
            replyMarkup: serializeReplyMarkup(m.replyMarkup),
          };
        })
        .reverse();
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

export const loadChatMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        target: z.string().min(1).max(200),
        accountId: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
        query: z.string().max(80).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    try {
      const entity = await resolveTargetEntity(client, Api, data.target);
      if (!(entity as any).megagroup && !(entity as any).chatId && (entity as any).broadcast) {
        // Broadcast channels: getParticipants only works for admins
      }
      const res: any = await client.invoke(
        new Api.channels.GetParticipants({
          channel: entity,
          filter: data.query
            ? new Api.ChannelParticipantsSearch({ q: data.query })
            : new Api.ChannelParticipantsRecent(),
          offset: data.offset,
          limit: data.limit,
          hash: 0 as any,
        }),
      );
      const users = new Map<string, any>();
      for (const u of res?.users ?? []) users.set(String(u.id), u);
      const parts = (res?.participants ?? []).map((p: any) => {
        const uid = p.userId ?? p.peer?.userId;
        const u = uid ? users.get(String(uid)) : null;
        return {
          userId: uid ? toNum(uid) : null,
          name: u ? displayName(u) : "Unknown",
          username: u?.username ?? null,
          isAdmin: p.className === "ChannelParticipantAdmin" || p.className === "ChannelParticipantCreator",
          isCreator: p.className === "ChannelParticipantCreator",
          isBot: !!u?.bot,
        };
      });
      return { total: Number(res?.count ?? parts.length), participants: parts };
    } catch (e) {
      return {
        total: 0,
        participants: [],
        error: (e as Error).message || "Cannot load members (permissions or private chat)",
      };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

export const sendQuickReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        target: z.string().min(1).max(200),
        accountId: z.string().uuid(),
        message: z.string().min(1).max(4096),
        replyToMsgId: z.number().int().positive().optional(),
        shareContact: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    try {
      const entity = await resolveTargetEntity(client, Api, data.target);
      // Mark chat as read before sending (mirror real-user behaviour)
      await markPeerRead(client, entity);
      const sent: any = data.shareContact
        ? await sendOwnContact(client, Api, entity, data.replyToMsgId)
        : await client.sendMessage(entity, {
            message: data.message,
            replyTo: data.replyToMsgId,
          });
      return { ok: true, id: Number(sent?.id ?? 0) };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

async function sendOwnContact(client: any, Api: any, entity: any, replyToMsgId?: number) {
  const me: any = await client.getMe();
  const phone = String(me?.phone ?? "");
  if (!phone) throw new Error("This Telegram account has no phone number available to share.");
  return await client.sendFile(entity, {
    file: new Api.InputMediaContact({
      phoneNumber: phone.startsWith("+") ? phone : `+${phone}`,
      firstName: String(me?.firstName ?? ""),
      lastName: String(me?.lastName ?? ""),
      vcard: "",
    }),
    replyTo: replyToMsgId,
  });
}