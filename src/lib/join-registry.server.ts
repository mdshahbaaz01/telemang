/**
 * Join accuracy registry.
 *
 * Backs four correctness features:
 *  - canonical fingerprint store (a link can never silently resolve elsewhere)
 *  - membership ledger + post-join verification sweep scheduling
 *  - approval (join request) tracking
 *  - permanent ban/restriction detection so hopeless pairs are never retried
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type JoinRegistryCtx = {
  supabase: SupabaseClient<any>;
  userId: string;
  accountId?: string | null;
};

export type ChatFingerprint = {
  chatId?: string | null;
  chatType?: string | null;
  title?: string | null;
  username?: string | null;
  requiresApproval?: boolean;
  isPublic?: boolean;
  discussionChatId?: string | null;
  migratedFromChatId?: string | null;
};

export type MembershipStatus =
  | "joined"
  | "requested"
  | "accepted"
  | "dropped"
  | "banned"
  | "left"
  | "failed";

/** Error codes that can never succeed again for this account + target pair. */
const PERMANENT_CODES: Record<string, string> = {
  USER_BANNED_IN_CHANNEL: "This account is banned in that chat",
  USER_DEACTIVATED: "Account is deactivated by Telegram",
  USER_DEACTIVATED_BAN: "Account is banned by Telegram",
  USER_RESTRICTED: "Account is restricted by Telegram",
  CHANNEL_BANNED: "Account is banned in that channel",
  INVITE_HASH_EXPIRED: "Invite link expired or was revoked",
  INVITE_HASH_INVALID: "Invite link is invalid",
  USERNAME_NOT_OCCUPIED: "That username does not exist",
  USERNAME_INVALID: "That username is not valid",
  CHAT_INVALID: "Chat no longer exists",
};

/** Codes that are worth retrying later (quota / rate / transient). */
const SOFT_CODES = /FLOOD_WAIT|CHANNELS_TOO_MUCH|TIMEOUT|CONNECTION|MSG_ID|AUTH_KEY_UNREGISTERED/i;

export function classifyJoinFailure(message: string): {
  code: string | null;
  permanent: boolean;
  reason: string;
} {
  const text = String(message ?? "");
  const code = text.match(/\b([A-Z][A-Z0-9_]{2,})\b/)?.[1] ?? null;
  if (code && !SOFT_CODES.test(code) && PERMANENT_CODES[code]) {
    return { code, permanent: true, reason: PERMANENT_CODES[code]! };
  }
  // CHANNEL_PRIVATE after a real join attempt means kicked / no access.
  if (code === "CHANNEL_PRIVATE") {
    return { code, permanent: true, reason: "Account has no access (kicked or private)" };
  }
  return { code, permanent: false, reason: text || "Join failed" };
}

export async function isTargetBlocked(
  ctx: JoinRegistryCtx,
  targetKey: string,
): Promise<{ blocked: boolean; reason?: string; code?: string | null }> {
  if (!targetKey || !ctx.accountId) return { blocked: false };
  const { data } = await ctx.supabase
    .from("join_blocklist")
    .select("reason, error_code, permanent")
    .eq("user_id", ctx.userId)
    .eq("account_id", ctx.accountId)
    .eq("target_key", targetKey)
    .maybeSingle();
  if (!data || data.permanent === false) return { blocked: false };
  return { blocked: true, reason: data.reason, code: data.error_code };
}

export async function blockTarget(
  ctx: JoinRegistryCtx,
  targetKey: string,
  reason: string,
  code: string | null,
): Promise<void> {
  if (!targetKey || !ctx.accountId) return;
  await ctx.supabase
    .from("join_blocklist")
    .upsert(
      {
        user_id: ctx.userId,
        account_id: ctx.accountId,
        target_key: targetKey,
        reason,
        error_code: code,
        permanent: true,
      },
      { onConflict: "user_id,account_id,target_key" },
    );
}

export async function unblockTarget(ctx: JoinRegistryCtx, id: string): Promise<void> {
  await ctx.supabase.from("join_blocklist").delete().eq("user_id", ctx.userId).eq("id", id);
}

/**
 * Store or verify the canonical identity of a target.
 * Returns drift descriptions when the resolved chat differs from what this
 * link resolved to before — a hard signal that something is wrong.
 */
export async function assertFingerprint(
  ctx: JoinRegistryCtx,
  targetKey: string,
  fp: ChatFingerprint,
): Promise<{ drift: string[]; known: boolean }> {
  if (!targetKey) return { drift: [], known: false };
  const { data: existing } = await ctx.supabase
    .from("join_fingerprints")
    .select("id, chat_id, chat_type, title, username")
    .eq("user_id", ctx.userId)
    .eq("target_key", targetKey)
    .maybeSingle();

  const drift: string[] = [];
  if (existing) {
    if (fp.chatId && existing.chat_id && String(existing.chat_id) !== String(fp.chatId)) {
      // A migrated legacy group legitimately changes id — record it, don't lie about it.
      if (fp.migratedFromChatId && String(fp.migratedFromChatId) === String(existing.chat_id)) {
        drift.push(`migrated ${existing.chat_id} → ${fp.chatId}`);
      } else {
        drift.push(`chat id changed ${existing.chat_id} → ${fp.chatId}`);
      }
    }
    if (fp.username && existing.username && existing.username !== fp.username) {
      drift.push(`username changed @${existing.username} → @${fp.username}`);
    }
    if (fp.title && existing.title && existing.title !== fp.title) {
      drift.push(`title changed "${existing.title}" → "${fp.title}"`);
    }
  }

  await ctx.supabase.from("join_fingerprints").upsert(
    {
      user_id: ctx.userId,
      target_key: targetKey,
      chat_id: fp.chatId ?? null,
      chat_type: fp.chatType ?? null,
      title: fp.title ?? null,
      username: fp.username ?? null,
      requires_approval: !!fp.requiresApproval,
      is_public: !!fp.isPublic,
      discussion_chat_id: fp.discussionChatId ?? null,
      migrated_from_chat_id: fp.migratedFromChatId ?? null,
      drift: drift.length ? drift : null,
      drift_at: drift.length ? new Date().toISOString() : null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id,target_key" },
  );

  return { drift, known: !!existing };
}

/** Minutes to wait before the sweep re-checks a fresh join. */
export const VERIFY_DELAY_MINUTES = 3;

export async function recordMembership(
  ctx: JoinRegistryCtx,
  targetKey: string,
  patch: {
    status: MembershipStatus;
    chatId?: string | null;
    chatType?: string | null;
    method?: string | null;
    errorCode?: string | null;
    verified?: boolean;
    scheduleVerify?: boolean;
  },
): Promise<void> {
  if (!targetKey || !ctx.accountId) return;
  const now = new Date();
  const verifyAfter =
    patch.scheduleVerify === false
      ? null
      : new Date(now.getTime() + VERIFY_DELAY_MINUTES * 60_000).toISOString();

  await ctx.supabase.from("join_memberships").upsert(
    {
      user_id: ctx.userId,
      account_id: ctx.accountId,
      target_key: targetKey,
      chat_id: patch.chatId ?? null,
      chat_type: patch.chatType ?? null,
      status: patch.status,
      method: patch.method ?? null,
      error_code: patch.errorCode ?? null,
      verify_after: verifyAfter,
      verified_at: patch.verified ? now.toISOString() : null,
    },
    { onConflict: "user_id,account_id,target_key" },
  );
}