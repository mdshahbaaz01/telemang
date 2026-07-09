import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any) {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

// ── helpers ──────────────────────────────────────────────────────────────
function normalizePeerKey(peerAny: any): string | null {
  if (!peerAny) return null;
  if (peerAny.className === "PeerUser" || peerAny.userId != null) return `u:${String(peerAny.userId)}`;
  if (peerAny.className === "PeerChannel" || peerAny.channelId != null) return `c:${String(peerAny.channelId)}`;
  if (peerAny.className === "PeerChat" || peerAny.chatId != null) return `g:${String(peerAny.chatId)}`;
  return null;
}

async function resolvePeerFromKey(client: any, Api: any, key: string) {
  const [kind, raw] = key.split(":");
  const { default: bigInt } = await import("big-integer");
  const id = bigInt(raw);
  if (kind === "u") return await client.getEntity(new Api.PeerUser({ userId: id }));
  if (kind === "c") return await client.getEntity(new Api.PeerChannel({ channelId: id }));
  if (kind === "g") return await client.getEntity(new Api.PeerChat({ chatId: id }));
  throw new Error(`Bad peer key: ${key}`);
}

function extractName(entity: any): string {
  if (!entity) return "Unknown";
  if (entity.title) return String(entity.title);
  const first = entity.firstName ?? "";
  const last = entity.lastName ?? "";
  const full = `${first} ${last}`.trim();
  return full || entity.username || String(entity.id ?? "Unknown");
}

function messagePreview(msg: any): string {
  if (!msg) return "";
  if (msg.message) return String(msg.message).slice(0, 120);
  if (msg.media) {
    const cn = msg.media.className ?? "";
    if (cn.includes("Photo")) return "🖼 Photo";
    if (cn.includes("Document")) return "📎 File";
    if (cn.includes("Video")) return "🎬 Video";
    if (cn.includes("Audio") || cn.includes("Voice")) return "🎧 Voice";
    if (cn.includes("Poll")) return "📊 Poll";
    return "📎 Attachment";
  }
  if (msg.action) return `⚙ ${msg.action.className ?? "Action"}`;
  return "";
}

async function serializeMessage(msg: any, meId: string): Promise<any> {
  const fromRaw = msg.fromId ?? msg.peerId;
  const fromKey = normalizePeerKey(fromRaw);
  const isOutgoing = !!msg.out || fromKey === `u:${meId}`;
  let mediaKind: string | null = null;
  let photoDataUrl: string | null = null;
  if (msg.media) {
    const cn = msg.media.className ?? "";
    if (cn.includes("Photo")) mediaKind = "photo";
    else if (cn.includes("Document")) mediaKind = "document";
    else if (cn.includes("Video")) mediaKind = "video";
    else if (cn.includes("Voice") || cn.includes("Audio")) mediaKind = "audio";
    else if (cn.includes("Poll")) mediaKind = "poll";
    else if (cn.includes("Webpage")) mediaKind = "webpage";
    else mediaKind = "other";
  }
  const reactions = (msg.reactions?.results ?? []).map((r: any) => ({
    emoji: r.reaction?.emoticon ?? "?",
    count: Number(r.count ?? 0),
    chosen: !!r.chosenOrder || r.chosen,
  }));
  return {
    id: Number(msg.id),
    date: msg.date ? Number(msg.date) * 1000 : Date.now(),
    text: typeof msg.message === "string" ? msg.message : "",
    out: isOutgoing,
    fromKey,
    replyTo: msg.replyTo?.replyToMsgId ? Number(msg.replyTo.replyToMsgId) : null,
    editDate: msg.editDate ? Number(msg.editDate) * 1000 : null,
    mediaKind,
    photoDataUrl,
    reactions,
    views: msg.views ?? null,
  };
}

async function downloadSmallPhoto(client: any, msg: any): Promise<string | null> {
  try {
    if (!msg.media || !(msg.media.className ?? "").includes("Photo")) return null;
    const buf = await client.downloadMedia(msg, { thumb: 1 });
    if (!buf) return null;
    const b64 = Buffer.from(buf).toString("base64");
    return `data:image/jpeg;base64,${b64}`;
  } catch {
    return null;
  }
}

async function downloadEntityAvatar(client: any, entity: any): Promise<string | null> {
  try {
    if (!entity || !entity.photo) return null;
    const buf = await client.downloadProfilePhoto(entity, { isBig: false });
    if (!buf || (buf as any).length === 0) return null;
    const b64 = Buffer.from(buf).toString("base64");
    return `data:image/jpeg;base64,${b64}`;
  } catch {
    return null;
  }
}

// ── listDialogs ─────────────────────────────────────────────────────────
export const listDialogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ accountId: z.string().uuid(), limit: z.number().int().min(1).max(200).default(80) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const me = await client.getMe();
      const meId = String((me as any).id);
      const dialogs = await client.getDialogs({ limit: data.limit });
      const out = dialogs.map((d: any) => {
        const entity = d.entity ?? {};
        const kind = entity.className?.includes("Channel") ? (entity.broadcast ? "channel" : "group") : entity.className?.includes("Chat") ? "group" : "user";
        const peerKey = normalizePeerKey({
          userId: kind === "user" ? entity.id : undefined,
          channelId: kind === "channel" || (kind === "group" && entity.className?.includes("Channel")) ? entity.id : undefined,
          chatId: kind === "group" && !entity.className?.includes("Channel") ? entity.id : undefined,
        });
        return {
          peerKey,
          title: extractName(entity),
          username: entity.username ?? null,
          kind,
          unread: Number(d.unreadCount ?? 0),
          pinned: !!d.pinned,
          lastMessagePreview: messagePreview(d.message),
          lastMessageDate: d.date ? Number(d.date) * 1000 : null,
          isSelf: kind === "user" && String(entity.id) === meId,
          verified: !!entity.verified,
          isChannel: kind === "channel",
        };
      }).filter((x: any) => x.peerKey);
      return { me: { id: meId, firstName: (me as any).firstName ?? "", username: (me as any).username ?? null }, dialogs: out };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── getHistory ──────────────────────────────────────────────────────────
export const getHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    peerKey: z.string().min(3),
    limit: z.number().int().min(1).max(100).default(50),
    offsetId: z.number().int().min(0).default(0),
    withThumbs: z.boolean().default(true),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const me = await client.getMe();
      const meId = String((me as any).id);
      const peer = await resolvePeerFromKey(client, Api, data.peerKey);
      const messages = await client.getMessages(peer, { limit: data.limit, offsetId: data.offsetId });
      // messages are newest→oldest; reverse for chronological order.
      const chronological = [...messages].reverse();
      const serialized = await Promise.all(chronological.map(async (m: any) => {
        const s = await serializeMessage(m, meId);
        if (data.withThumbs && s.mediaKind === "photo") {
          s.photoDataUrl = await downloadSmallPhoto(client, m);
        }
        return s;
      }));
      const hasMore = messages.length === data.limit;
      const oldestId = chronological[0]?.id ?? null;
      return { messages: serialized, hasMore, oldestId };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── sendMessageAs ───────────────────────────────────────────────────────
export const sendMessageAs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    peerKey: z.string().min(3),
    text: z.string().min(1).max(4096),
    replyToMsgId: z.number().int().positive().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    // paused_until check
    const { data: acct } = await context.supabase
      .from("telegram_accounts")
      .select("paused_until")
      .eq("id", data.accountId)
      .maybeSingle();
    if (acct?.paused_until && new Date(acct.paused_until).getTime() > Date.now()) {
      throw new Error("Account is paused (FloodWait). Try again later.");
    }
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const peer = await resolvePeerFromKey(client, Api, data.peerKey);
      const sent: any = await client.sendMessage(peer, {
        message: data.text,
        replyTo: data.replyToMsgId,
      });
      return { id: Number(sent.id), date: sent.date ? Number(sent.date) * 1000 : Date.now() };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── markRead ────────────────────────────────────────────────────────────
export const markRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ accountId: z.string().uuid(), peerKey: z.string().min(3) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const peer = await resolvePeerFromKey(client, Api, data.peerKey);
      await client.markAsRead(peer);
      return { ok: true };
    } catch {
      return { ok: false };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── sendReactionAs ──────────────────────────────────────────────────────
export const sendReactionAs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    peerKey: z.string().min(3),
    msgId: z.number().int().positive(),
    emoji: z.string().max(16).nullable(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const peer = await resolvePeerFromKey(client, Api, data.peerKey);
      await client.invoke(new Api.messages.SendReaction({
        peer,
        msgId: data.msgId,
        reaction: data.emoji ? [new Api.ReactionEmoji({ emoticon: data.emoji })] : [],
      }));
      return { ok: true };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── deleteMessagesAs ────────────────────────────────────────────────────
export const deleteMessagesAs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    peerKey: z.string().min(3),
    ids: z.array(z.number().int().positive()).min(1).max(100),
    revoke: z.boolean().default(true),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const peer = await resolvePeerFromKey(client, Api, data.peerKey);
      await client.deleteMessages(peer, data.ids, { revoke: data.revoke });
      return { ok: true };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });