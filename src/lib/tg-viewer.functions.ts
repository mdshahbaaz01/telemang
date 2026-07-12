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
  // Allow @username as a peer key — resolve to entity directly.
  if (key.startsWith("@")) {
    return await client.getEntity(key.slice(1));
  }
  const [kind, raw] = key.split(":");
  const { default: bigInt } = await import("big-integer");
  const id = bigInt(raw);
  const peer =
    kind === "u" ? new Api.PeerUser({ userId: id }) :
    kind === "c" ? new Api.PeerChannel({ channelId: id }) :
    kind === "g" ? new Api.PeerChat({ chatId: id }) :
    null;
  if (!peer) throw new Error(`Bad peer key: ${key}`);
  try {
    return await client.getEntity(peer);
  } catch {
    // Prime entity cache (access_hash) then retry.
    await client.getDialogs({ limit: 200 }).catch(() => {});
    return await client.getEntity(peer);
  }
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

// ── inline-button serialization (mirrors broadcast-replies.functions) ────
export type SerializedInlineButton =
  | { kind: "callback"; text: string; data: string /* base64 */; requiresPassword?: boolean }
  | { kind: "url"; text: string; url: string }
  | { kind: "urlAuth"; text: string; url: string; buttonId?: number }
  | { kind: "switchInline"; text: string; query: string; samePeer: boolean }
  | { kind: "webview"; text: string; url?: string }
  | { kind: "game"; text: string }
  | { kind: "buy"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "other"; text: string; className: string };

function serializeButton(btn: any): SerializedInlineButton {
  const cn = String(btn?.className ?? "");
  const text = String(btn?.text ?? "");
  if (cn.includes("Callback")) {
    const data = btn?.data ? Buffer.from(btn.data).toString("base64") : "";
    return { kind: "callback", text, data, requiresPassword: !!btn?.requiresPassword };
  }
  if (cn === "KeyboardButtonUrl") return { kind: "url", text, url: String(btn?.url ?? "") };
  if (cn === "KeyboardButtonUrlAuth" || cn === "InputKeyboardButtonUrlAuth")
    return { kind: "urlAuth", text, url: String(btn?.url ?? ""), buttonId: btn?.buttonId };
  if (cn === "KeyboardButtonSwitchInline")
    return { kind: "switchInline", text, query: String(btn?.query ?? ""), samePeer: !!btn?.samePeer };
  if (cn === "KeyboardButtonWebView" || cn === "KeyboardButtonSimpleWebView")
    return { kind: "webview", text, url: btn?.url ? String(btn.url) : undefined };
  if (cn === "KeyboardButtonGame") return { kind: "game", text };
  if (cn === "KeyboardButtonBuy") return { kind: "buy", text };
  if (cn === "KeyboardButton") return { kind: "reply", text };
  return { kind: "other", text, className: cn };
}

export type SerializedReplyMarkup =
  | { kind: "inline"; rows: SerializedInlineButton[][] }
  | { kind: "keyboard"; rows: SerializedInlineButton[][]; oneTime: boolean; resize: boolean; placeholder?: string }
  | { kind: "hide" }
  | { kind: "forceReply"; placeholder?: string };

function serializeReplyMarkup(markup: any): SerializedReplyMarkup | null {
  if (!markup) return null;
  const cn = String(markup?.className ?? "");
  if (cn.includes("ReplyKeyboardHide")) return { kind: "hide" };
  if (cn.includes("ReplyKeyboardForceReply"))
    return { kind: "forceReply", placeholder: markup?.placeholder ? String(markup.placeholder) : undefined };
  const rows = Array.isArray(markup.rows) ? markup.rows : [];
  const parsed = rows
    .map((row: any) => (Array.isArray(row?.buttons) ? row.buttons.map(serializeButton) : []))
    .filter((r: SerializedInlineButton[]) => r.length > 0);
  if (!parsed.length) return null;
  if (cn.includes("ReplyKeyboardMarkup"))
    return {
      kind: "keyboard",
      rows: parsed,
      oneTime: !!markup?.singleUse,
      resize: !!markup?.resize,
      placeholder: markup?.placeholder ? String(markup.placeholder) : undefined,
    };
  if (cn.includes("ReplyInlineMarkup")) return { kind: "inline", rows: parsed };
  return null;
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
    replyMarkup: serializeReplyMarkup(msg.replyMarkup),
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
  .inputValidator((d: unknown) => z.object({
    accountId: z.string().uuid(),
    limit: z.number().int().min(1).max(5000).default(1000),
    withPhotos: z.boolean().default(true),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const me = await client.getMe();
      const meId = String((me as any).id);
      const dialogs = await client.getDialogs({ limit: data.limit });
      const rawOut = dialogs.map((d: any) => {
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
          isBot: kind === "user" && !!entity.bot,
          unread: Number(d.unreadCount ?? 0),
          pinned: !!d.pinned,
          lastMessagePreview: messagePreview(d.message),
          lastMessageDate: d.date ? Number(d.date) * 1000 : null,
          isSelf: kind === "user" && String(entity.id) === meId,
          verified: !!entity.verified,
          isChannel: kind === "channel",
          _entity: entity,
        };
      }).filter((x: any) => x.peerKey);
      const withPhotos = data.withPhotos
        ? await Promise.all(rawOut.map(async (d: any) => {
            const photoDataUrl = await downloadEntityAvatar(client, d._entity);
            const { _entity, ...rest } = d;
            return { ...rest, photoDataUrl };
          }))
        : rawOut.map((d: any) => { const { _entity, ...rest } = d; return { ...rest, photoDataUrl: null }; });
      const mePhoto = data.withPhotos ? await downloadEntityAvatar(client, me) : null;
      const meFirst = (me as any).firstName ?? "";
      const meLast = (me as any).lastName ?? "";
      const meName = `${meFirst} ${meLast}`.trim() || (me as any).username || "Me";
      return {
        me: {
          id: meId,
          firstName: meFirst,
          lastName: meLast,
          name: meName,
          username: (me as any).username ?? null,
          phone: (me as any).phone ?? null,
          photoDataUrl: mePhoto,
        },
        dialogs: withPhotos,
      };
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
      try {
        const sent: any = await client.sendMessage(peer, {
          message: data.text,
          replyTo: data.replyToMsgId,
        });
        return { id: Number(sent.id), date: sent.date ? Number(sent.date) * 1000 : Date.now() };
      } catch (e: any) {
        const msg = String(e?.errorMessage || e?.message || e);
        if (msg.includes("CHAT_ADMIN_REQUIRED")) {
          throw new Error("You can't send messages here — this chat requires admin rights (read-only channel or restricted group).");
        }
        if (msg.includes("CHAT_WRITE_FORBIDDEN") || msg.includes("USER_BANNED_IN_CHANNEL")) {
          throw new Error("This account isn't allowed to post in this chat.");
        }
        if (msg.includes("SLOWMODE_WAIT")) {
          throw new Error("Slow mode is active — wait before sending again.");
        }
        throw e;
      }
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

// ── pressInlineButtonAs (mini viewer) ───────────────────────────────────
export const pressInlineButtonAs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.string().uuid(),
        peerKey: z.string().min(3),
        msgId: z.number().int().positive(),
        data: z.string().min(1).max(700),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { data: acct } = await context.supabase
      .from("telegram_accounts")
      .select("paused_until")
      .eq("id", data.accountId)
      .maybeSingle();
    if (acct?.paused_until && new Date(acct.paused_until).getTime() > Date.now()) {
      throw new Error("Account is paused (FloodWait). Try again later.");
    }
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const peer = await resolvePeerFromKey(client, Api, data.peerKey);
      const buf = Buffer.from(data.data, "base64");
      try {
        const res: any = await client.invoke(
          new Api.messages.GetBotCallbackAnswer({ peer, msgId: data.msgId, data: buf }),
        );
        return {
          message: res?.message ? String(res.message) : "",
          alert: !!res?.alert,
          url: res?.url ? String(res.url) : null,
        };
      } catch (e) {
        const em = (e as Error).message || String(e);
        const m = em.match(/FLOOD_WAIT_(\d+)/i);
        if (m) {
          const secs = Number(m[1]);
          await context.supabase
            .from("telegram_accounts")
            .update({
              paused_until: new Date(Date.now() + secs * 1000).toISOString(),
              last_error: `FloodWait ${secs}s`,
            })
            .eq("id", data.accountId);
          throw new Error(`FloodWait ${secs}s — account paused`);
        }
        throw new Error(em);
      }
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── openMiniApp — resolves a Telegram Mini App URL for iframe embed ─────
export const openMiniApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.string().uuid(),
        // Chat where the message/button lives (also the bot chat when 1-1)
        peerKey: z.string().min(3),
        // Bot peer key. When omitted, uses peerKey (works for direct bot chats)
        botKey: z.string().min(3).optional(),
        // URL from the KeyboardButtonWebView / SimpleWebView. Optional for menu-button.
        url: z.string().url().max(2048).optional(),
        // Text label of the button (RequestWebView requires it when using inline button)
        buttonText: z.string().max(120).optional(),
        // If true → use RequestSimpleWebView (no peer binding); default false
        simple: z.boolean().default(false),
        // Theme hints forwarded as themeParams
        themeParams: z
          .object({
            bg_color: z.string().optional(),
            text_color: z.string().optional(),
            hint_color: z.string().optional(),
            link_color: z.string().optional(),
            button_color: z.string().optional(),
            button_text_color: z.string().optional(),
          })
          .partial()
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const { deriveMiniAppIdentity } = await import("./mini-app-identity.server");
    const client = await openClientForAccount(context.supabase, data.accountId);
    const identity = deriveMiniAppIdentity(data.accountId);
    try {
      const peer = await resolvePeerFromKey(client, Api, data.peerKey);
      const bot = data.botKey
        ? await resolvePeerFromKey(client, Api, data.botKey)
        : peer;
      const themeJson = JSON.stringify(
        data.themeParams ?? identity.themeParams,
      );
      const themeParams = new Api.DataJSON({ data: themeJson });
      try {
        const res: any = data.simple
          ? await client.invoke(
              new Api.messages.RequestSimpleWebView({
                bot,
                url: data.url,
                platform: identity.platform,
                themeParams,
              } as any),
            )
          : await client.invoke(
              new Api.messages.RequestWebView({
                peer,
                bot,
                url: data.url,
                platform: identity.platform,
                themeParams,
                fromBotMenu: !data.url,
              } as any),
            );
        return {
          url: String(res?.url ?? ""),
          queryId: res?.queryId ? String(res.queryId) : null,
          platform: identity.platform,
        };
      } catch (e) {
        const em = (e as Error).message || String(e);
        if (em.includes("BOT_INVALID"))
          throw new Error("This chat isn't a bot — mini apps only work with bots.");
        if (em.includes("URL_INVALID"))
          throw new Error("The mini app URL is invalid.");
        if (em.includes("BOT_WEBVIEW_DISABLED"))
          throw new Error("This bot has no mini app enabled.");
        throw new Error(em);
      }
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── openStartAppLink — resolves a t.me/{bot}?startapp=CODE main mini app URL
export const openStartAppLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.string().uuid(),
        botUsername: z.string().min(1).max(64),
        startParam: z.string().max(256).optional(),
        themeParams: z
          .object({
            bg_color: z.string().optional(),
            text_color: z.string().optional(),
            hint_color: z.string().optional(),
            link_color: z.string().optional(),
            button_color: z.string().optional(),
            button_text_color: z.string().optional(),
          })
          .partial()
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const { deriveMiniAppIdentity } = await import("./mini-app-identity.server");
    const client = await openClientForAccount(context.supabase, data.accountId);
    const identity = deriveMiniAppIdentity(data.accountId);
    try {
      const bot: any = await client.getEntity(data.botUsername.replace(/^@/, ""));
      const themeJson = JSON.stringify(
        data.themeParams ?? identity.themeParams,
      );
      const themeParams = new Api.DataJSON({ data: themeJson });
      const tryInvoke = async () => {
        // Prefer RequestMainWebView (t.me/bot?startapp handler) when available
        const MainWebView = (Api as any)?.messages?.RequestMainWebView;
        if (MainWebView) {
          try {
            return await client.invoke(
              new MainWebView({
                peer: bot,
                bot,
                startParam: data.startParam,
                platform: identity.platform,
                themeParams,
              } as any),
            );
          } catch (e) {
            // fall through to SimpleWebView
          }
        }
        return await client.invoke(
          new Api.messages.RequestSimpleWebView({
            bot,
            platform: identity.platform,
            themeParams,
            startParam: data.startParam,
            fromSwitchWebview: false,
          } as any),
        );
      };
      try {
        const res: any = await tryInvoke();
        return {
          url: String(res?.url ?? ""),
          queryId: res?.queryId ? String(res.queryId) : null,
          platform: identity.platform,
        };
      } catch (e) {
        const em = (e as Error).message || String(e);
        if (em.includes("BOT_INVALID"))
          throw new Error("Not a bot username.");
        if (em.includes("BOT_WEBVIEW_DISABLED"))
          throw new Error("This bot has no mini app enabled.");
        if (em.includes("USERNAME_INVALID") || em.includes("USERNAME_NOT_OCCUPIED"))
          throw new Error("Unknown bot username.");
        throw new Error(em);
      }
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// ── joinFromLink — resolve any t.me link with a given account, join if
// needed, and return a peerKey the Account Viewer can open. Used by the
// mini-app iframe's "Join channel" interception so the user stays inside
// the same account's tile instead of being sent to a new tab.
export const joinFromLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.string().uuid(),
        url: z.string().min(3).max(2048),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const raw = data.url.trim();
      // Extract path from tg:// or https://t.me/...
      let path = raw
        .replace(/^tg:\/\/(join|resolve)\?/, "")
        .replace(/^https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i, "");
      // Handle tg://resolve?domain=xxx style
      if (path.startsWith("domain=")) {
        const uname = new URLSearchParams(path).get("domain");
        path = uname || path;
      } else if (path.startsWith("invite=")) {
        const hash = new URLSearchParams(path).get("invite");
        path = `+${hash || ""}`;
      }
      const inviteMatch = path.match(/^(?:joinchat\/|\+)([A-Za-z0-9_-]+)/);
      let entity: any = null;
      let joined = false;
      let alreadyMember = false;
      if (inviteMatch) {
        const hash = inviteMatch[1];
        try {
          const upd: any = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
          joined = true;
          const chat = upd?.chats?.[0];
          if (chat) entity = chat;
        } catch (e) {
          const em = (e as Error).message || "";
          if (em.includes("USER_ALREADY_PARTICIPANT")) {
            alreadyMember = true;
            try {
              const info: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
              entity = info?.chat ?? info?.channel ?? null;
            } catch {}
          } else {
            throw new Error(em);
          }
        }
      } else {
        // Public username or username/msgId path
        const uname = path.split(/[/?#]/)[0].replace(/^@/, "");
        if (!uname) throw new Error("Unrecognized Telegram link");
        entity = await client.getEntity(uname);
        const cn = entity?.className || "";
        if (cn === "Channel" || cn.includes("Channel")) {
          try {
            await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
            joined = true;
          } catch (e) {
            const em = (e as Error).message || "";
            if (em.includes("USER_ALREADY_PARTICIPANT")) alreadyMember = true;
            else if (!em.includes("CHANNELS_TOO_MUCH")) {
              // Ignore other join errors — user can still view public channels
            }
          }
        }
      }
      if (!entity) throw new Error("Could not resolve entity from link");
      const username = entity?.username ? `@${entity.username}` : null;
      const idStr = String(entity?.id ?? "");
      const cn = entity?.className || "";
      const peerKey =
        username ||
        (cn.includes("Channel") ? `c:${idStr}` : cn.includes("Chat") ? `g:${idStr}` : `u:${idStr}`);
      return {
        peerKey,
        title: extractName(entity),
        joined,
        alreadyMember,
      };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });