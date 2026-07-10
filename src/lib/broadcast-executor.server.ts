import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type Attachment = { path: string; filename: string; mimeType?: string; isVoice?: boolean };

export type BroadcastRowInput = {
  accountId: string;
  message: string;
  targets: string[];
  attachment?: Attachment;
  attachments?: Attachment[];
  format?: "plain" | "mono" | "quote" | "html";
};

export type BroadcastExecInput = {
  rows: BroadcastRowInput[];
  minDelay: number;
  maxDelay: number;
};

export type BroadcastExecResult = {
  ok: number;
  fail: number;
  logs: Array<{ accountId: string | null; target: string | null; level: string; message: string }>;
};

export type SourceRef = { chat: string; msgId: number };

export type ReplyRowInput = {
  accountId: string;
  message: string;
  attachment?: Attachment;
  attachments?: Attachment[];
  format?: "plain" | "mono" | "quote" | "html";
};

export type ReplyExecInput = {
  source: SourceRef;
  viaDiscussion: boolean;
  rows: ReplyRowInput[];
  minDelay: number;
  maxDelay: number;
};

export type ForwardExecInput = {
  source: SourceRef;
  accountIds: string[];
  targets: string[];
  minDelay: number;
  maxDelay: number;
};

function jitter(min: number, max: number) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo * 1000 + Math.random() * (hi - lo) * 1000;
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

import { formatMessage } from "./message-format";

async function resolveTargetEntity(client: any, Api: any, t: string) {
  const cleaned = t.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
  // Private invite links: t.me/+HASH or t.me/joinchat/HASH
  const inviteMatch = cleaned.match(/^(?:joinchat\/)?\+?([A-Za-z0-9_-]{16,})$/);
  if (cleaned.startsWith("+") || cleaned.startsWith("joinchat/")) {
    const hash = inviteMatch ? inviteMatch[1] : cleaned.replace(/^\+/, "").replace(/^joinchat\//, "");
    try {
      const info: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
      // Already joined → info.chat exists
      if (info?.chat) return info.chat;
      // Not joined yet → import (join)
      const upd: any = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      const chat = upd?.chats?.[0];
      if (chat) return chat;
    } catch (e: any) {
      const msg = String(e?.errorMessage || e?.message || e);
      if (msg.includes("INVITE_HASH_EXPIRED") || msg.includes("INVITE_HASH_INVALID")) {
        throw new Error(`Invite link expired or invalid: ${t}`);
      }
      if (msg.includes("USER_ALREADY_PARTICIPANT")) {
        // Re-check to get the entity now that we're a member.
        const info: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
        if (info?.chat) return info.chat;
      }
      throw e;
    }
    throw new Error(`Could not resolve invite link: ${t}`);
  }
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

async function resolveSourcePeer(client: any, Api: any, src: SourceRef) {
  if (src.chat.startsWith("c/")) {
    const raw = src.chat.slice(2);
    const { default: bigInt } = await import("big-integer");
    try {
      return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
    } catch {
      return await client.getEntity(`https://t.me/c/${raw}/${src.msgId}`);
    }
  }
  return await client.getEntity(src.chat.replace(/^@/, ""));
}

function pickDiscussionTarget(disc: any) {
  const chats = (disc?.chats ?? []) as any[];
  const messages = (disc?.messages ?? []) as any[];
  const rootMsg = messages.reduce((best, msg) => {
    if (!best) return msg;
    return Number(msg?.id ?? 0) < Number(best?.id ?? 0) ? msg : best;
  }, null as any);
  const peerId = rootMsg?.peerId?.channelId ?? rootMsg?.peerId?.chatId;
  if (peerId) {
    const match = chats.find((chat) => String(chat?.id) === String(peerId));
    if (match) return { chat: match, msgId: rootMsg.id as number };
  }
  const fallback =
    chats.find((chat) => chat?.megagroup || chat?.gigagroup || chat?.forum) ??
    chats.find((chat) => !chat?.broadcast) ??
    chats[0];
  return fallback && rootMsg ? { chat: fallback, msgId: rootMsg.id as number } : null;
}

/**
 * Standalone broadcast executor — mirrors the broadcast branch of
 * /api/public/actions-stream but without SSE, so it can run inside a cron
 * worker for scheduled dispatches. Accuracy note: the *dispatch loop* is
 * fired at the exact millisecond by the caller; per-target jitter delays
 * apply *after* the first message goes out.
 */
export async function executeBroadcast(
  supabase: SupabaseClient<Database>,
  input: BroadcastExecInput,
): Promise<BroadcastExecResult> {
  const { openClientForAccount } = await import("./cleanup.server");
  const { Api } = await import("telegram");
  const { CustomFile } = await import("telegram/client/uploads");

  const logs: BroadcastExecResult["logs"] = [];
  const push = (l: (typeof logs)[number]) => logs.push(l);

  const attachmentCache = new Map<string, { buf: Buffer; filename: string; mimeType?: string; isVoice?: boolean }>();
  const loadAttachment = async (att: { path: string; filename: string; mimeType?: string; isVoice?: boolean }) => {
    const cached = attachmentCache.get(att.path);
    if (cached) return cached;
    const { data, error } = await supabase.storage
      .from("action-attachments")
      .createSignedUrl(att.path, 300);
    if (error || !data?.signedUrl) throw new Error(`Attachment fetch failed: ${error?.message ?? "no url"}`);
    const res = await fetch(data.signedUrl);
    if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const val = { buf, filename: att.filename, mimeType: att.mimeType, isVoice: att.isVoice };
    attachmentCache.set(att.path, val);
    return val;
  };

  const resolveTarget = (client: any, t: string) => resolveTargetEntity(client, Api, t);

  // Group rows by account so each account only connects once.
  const byAccount = new Map<string, BroadcastRowInput[]>();
  for (const row of input.rows) {
    const arr = byAccount.get(row.accountId) ?? [];
    arr.push(row);
    byAccount.set(row.accountId, arr);
  }

  let ok = 0;
  let fail = 0;

  // All accounts fire in parallel so scheduled dispatch is not serialized.
  await Promise.all(
    Array.from(byAccount.entries()).map(async ([accountId, rows]) => {
      let client;
      try {
        client = await openClientForAccount(supabase, accountId);
      } catch (e) {
        const m = `Connect failed: ${errorText(e)}`;
        push({ accountId, target: null, level: "error", message: m });
        fail += rows.reduce((n, r) => n + r.targets.length, 0);
        return;
      }
      try {
        for (const row of rows) {
          const rowAtts = (row.attachments && row.attachments.length > 0
            ? row.attachments
            : row.attachment
              ? [row.attachment]
              : []) as Attachment[];
          let attDatas: Array<{ buf: Buffer; filename: string; mimeType?: string; isVoice?: boolean }> = [];
          if (rowAtts.length) {
            try {
              attDatas = await Promise.all(rowAtts.map((a) => loadAttachment(a)));
            } catch (e) {
              const em = errorText(e);
              fail += row.targets.length;
              push({ accountId, target: null, level: "error", message: em });
              continue;
            }
          }
          for (const t of row.targets) {
            try {
              const dest = await resolveTarget(client, t);
              if (attDatas.length > 1) {
                const formatted = formatMessage(row.message, row.format);
                await client.sendFile(dest, {
                  file: attDatas.map((a) => new CustomFile(a.filename, a.buf.length, a.filename, a.buf)),
                  caption: formatted.message || undefined,
                  parseMode: formatted.parseMode,
                });
              } else if (attDatas.length === 1) {
                const attData = attDatas[0];
                const formatted = formatMessage(row.message, row.format);
                await client.sendFile(dest, {
                  file: new CustomFile(attData.filename, attData.buf.length, attData.filename, attData.buf),
                  caption: formatted.message || undefined,
                  parseMode: formatted.parseMode,
                  voiceNote: !!attData.isVoice,
                });
              } else {
                await client.sendMessage(dest, formatMessage(row.message, row.format));
              }
              ok++;
              push({ accountId, target: t, level: "success", message: `Sent to ${t}` });
            } catch (e) {
              fail++;
              const em = errorText(e);
              push({ accountId, target: t, level: "error", message: em });
            }
            await new Promise((r) => setTimeout(r, jitter(input.minDelay, input.maxDelay)));
          }
        }
      } finally {
        await client.disconnect().catch(() => {});
      }
    }),
  );

  return { ok, fail, logs };
}

/**
 * Scheduled reply/comment dispatcher. `viaDiscussion=true` routes replies
 * into the channel's linked discussion group (comment on a channel post).
 */
export async function executeReply(
  supabase: SupabaseClient<Database>,
  input: ReplyExecInput,
): Promise<BroadcastExecResult> {
  const { openClientForAccount } = await import("./cleanup.server");
  const { Api } = await import("telegram");
  const { CustomFile } = await import("telegram/client/uploads");

  const logs: BroadcastExecResult["logs"] = [];
  const push = (l: (typeof logs)[number]) => logs.push(l);

  const attachmentCache = new Map<string, { buf: Buffer; filename: string; mimeType?: string; isVoice?: boolean }>();
  const loadAttachment = async (att: { path: string; filename: string; mimeType?: string; isVoice?: boolean }) => {
    const cached = attachmentCache.get(att.path);
    if (cached) return cached;
    const { data, error } = await supabase.storage
      .from("action-attachments")
      .createSignedUrl(att.path, 300);
    if (error || !data?.signedUrl) throw new Error(`Attachment fetch failed: ${error?.message ?? "no url"}`);
    const res = await fetch(data.signedUrl);
    if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const val = { buf, filename: att.filename, mimeType: att.mimeType, isVoice: att.isVoice };
    attachmentCache.set(att.path, val);
    return val;
  };

  // Group rows by account.
  const byAccount = new Map<string, ReplyRowInput[]>();
  for (const row of input.rows) {
    const arr = byAccount.get(row.accountId) ?? [];
    arr.push(row);
    byAccount.set(row.accountId, arr);
  }

  let ok = 0;
  let fail = 0;
  const targetLabel = `${input.source.chat}/${input.source.msgId}`;

  await Promise.all(
    Array.from(byAccount.entries()).map(async ([accountId, rows]) => {
      let client;
      try {
        client = await openClientForAccount(supabase, accountId);
      } catch (e) {
        const m = `Connect failed: ${errorText(e)}`;
        push({ accountId, target: null, level: "error", message: m });
        fail += rows.length;
        return;
      }
      try {
        const sourcePeer = await resolveSourcePeer(client, Api, input.source);
        let replyPeer: any = sourcePeer;
        let replyToId = input.source.msgId;
        let topMsgId: number | undefined;
        if (input.viaDiscussion) {
          const disc: any = await client.invoke(
            new Api.messages.GetDiscussionMessage({ peer: sourcePeer, msgId: input.source.msgId }),
          );
          const dt = pickDiscussionTarget(disc);
          if (!dt) throw new Error("No discussion group linked to this channel");
          replyPeer = await client.getEntity(dt.chat);
          replyToId = dt.msgId;
          topMsgId = dt.msgId;
        }
        for (const row of rows) {
          try {
            const rowAtts = (row.attachments && row.attachments.length > 0
              ? row.attachments
              : row.attachment
                ? [row.attachment]
                : []) as Attachment[];
            const attDatas = rowAtts.length ? await Promise.all(rowAtts.map((a) => loadAttachment(a))) : [];
            if (attDatas.length > 1) {
              const formatted = formatMessage(row.message, row.format);
              await client.sendFile(replyPeer, {
                file: attDatas.map((a) => new CustomFile(a.filename, a.buf.length, a.filename, a.buf)),
                caption: formatted.message || undefined,
                parseMode: formatted.parseMode,
                replyTo: replyToId,
                ...(topMsgId ? { topMsgId } : {}),
              });
            } else if (attDatas.length === 1) {
              const attData = attDatas[0];
              const formatted = formatMessage(row.message, row.format);
              await client.sendFile(replyPeer, {
                file: new CustomFile(attData.filename, attData.buf.length, attData.filename, attData.buf),
                caption: formatted.message || undefined,
                parseMode: formatted.parseMode,
                voiceNote: !!attData.isVoice,
                replyTo: replyToId,
                ...(topMsgId ? { topMsgId } : {}),
              });
            } else {
              await client.sendMessage(replyPeer, {
                ...formatMessage(row.message, row.format),
                replyTo: replyToId,
                ...(topMsgId ? { topMsgId } : {}),
              });
            }
            ok++;
            push({ accountId, target: targetLabel, level: "success", message: `${input.viaDiscussion ? "Commented" : "Replied"} on ${targetLabel}` });
          } catch (e) {
            fail++;
            push({ accountId, target: targetLabel, level: "error", message: errorText(e) });
          }
          await new Promise((r) => setTimeout(r, jitter(input.minDelay, input.maxDelay)));
        }
      } catch (e) {
        fail += rows.length;
        push({ accountId, target: targetLabel, level: "error", message: errorText(e) });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }),
  );

  return { ok, fail, logs };
}

/**
 * Scheduled forward dispatcher — each account forwards the source message
 * to every target.
 */
export async function executeForward(
  supabase: SupabaseClient<Database>,
  input: ForwardExecInput,
): Promise<BroadcastExecResult> {
  const { openClientForAccount } = await import("./cleanup.server");
  const { Api } = await import("telegram");

  const logs: BroadcastExecResult["logs"] = [];
  const push = (l: (typeof logs)[number]) => logs.push(l);

  let ok = 0;
  let fail = 0;

  await Promise.all(
    input.accountIds.map(async (accountId) => {
      let client;
      try {
        client = await openClientForAccount(supabase, accountId);
      } catch (e) {
        push({ accountId, target: null, level: "error", message: `Connect failed: ${errorText(e)}` });
        fail += input.targets.length;
        return;
      }
      try {
        const sourcePeer = await resolveSourcePeer(client, Api, input.source);
        const { default: bigInt } = await import("big-integer");
        for (const t of input.targets) {
          try {
            const dest = await resolveTargetEntity(client, Api, t);
            await client.invoke(
              new Api.messages.ForwardMessages({
                fromPeer: sourcePeer,
                id: [input.source.msgId],
                randomId: [bigInt(Math.floor(Math.random() * 1e18))],
                toPeer: dest,
              }),
            );
            ok++;
            push({ accountId, target: t, level: "success", message: `Forwarded to ${t}` });
          } catch (e) {
            fail++;
            push({ accountId, target: t, level: "error", message: errorText(e) });
          }
          await new Promise((r) => setTimeout(r, jitter(input.minDelay, input.maxDelay)));
        }
      } catch (e) {
        fail += input.targets.length;
        push({ accountId, target: null, level: "error", message: errorText(e) });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }),
  );

  return { ok, fail, logs };
}