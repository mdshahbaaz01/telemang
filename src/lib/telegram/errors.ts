/**
 * Shared Telegram error classification. Pure, client-safe (no server-only imports).
 * Extracted during Phase 2 refactor — DRY the many `FLOOD_WAIT` regex sites.
 */

export interface ParsedFloodWait {
  seconds: number;
}

/** Extract FloodWait seconds from an error message or GramJS error object. */
export function parseFloodWait(err: unknown): ParsedFloodWait | null {
  if (!err) return null;
  const anyErr = err as { seconds?: number; message?: string; toString?: () => string };
  const msg = anyErr.message ?? String(err);
  if (typeof anyErr.seconds === "number" && anyErr.seconds > 0) {
    return { seconds: anyErr.seconds };
  }
  const m =
    msg.match(/FLOOD_WAIT_?(\d+)/i) ||
    msg.match(/FloodWait\s+(\d+)/i) ||
    msg.match(/Rate-limited\s+(\d+)/i);
  if (m) return { seconds: Number(m[1]) };
  return null;
}

export function isFloodWait(err: unknown): boolean {
  return parseFloodWait(err) !== null;
}

/** Telegram error codes we care about — used by executors to classify failures. */
export type TelegramErrorClass =
  | "flood_wait"
  | "auth_key_unregistered"
  | "user_deactivated"
  | "channel_private"
  | "invite_hash_invalid"
  | "invite_hash_expired"
  | "user_already_participant"
  | "peer_id_invalid"
  | "unknown";

export function classifyTelegramError(err: unknown): TelegramErrorClass {
  const msg = (err as { message?: string })?.message ?? String(err ?? "");
  if (isFloodWait(err)) return "flood_wait";
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(msg)) return "auth_key_unregistered";
  if (/USER_DEACTIVATED/i.test(msg)) return "user_deactivated";
  if (/CHANNEL_PRIVATE/i.test(msg)) return "channel_private";
  if (/INVITE_HASH_INVALID/i.test(msg)) return "invite_hash_invalid";
  if (/INVITE_HASH_EXPIRED/i.test(msg)) return "invite_hash_expired";
  if (/USER_ALREADY_PARTICIPANT/i.test(msg)) return "user_already_participant";
  if (/PEER_ID_INVALID/i.test(msg)) return "peer_id_invalid";
  return "unknown";
}

/** Terminal = the account/target is broken; retrying won't help until fixed. */
export function isTerminalAccountError(err: unknown): boolean {
  const cls = classifyTelegramError(err);
  return cls === "auth_key_unregistered" || cls === "user_deactivated";
}

/**
 * Map a raw Telegram error or gramjs message into a short, human-friendly
 * reason string suitable for surfacing in the bot flow UI.
 * Returns `null` when the reason is unknown so callers can fall back to the
 * raw message.
 */
export function friendlyJoinReason(input: {
  code?: string | null;
  message?: string | null;
  status?: "joined" | "requested" | "failed" | "skipped" | "flood" | null;
  floodSeconds?: number | null;
}): string | null {
  const code = (input.code || "").toUpperCase();
  const msg = input.message || "";
  if (input.status === "requested" || /INVITE_REQUEST_SENT|REQUEST_SENT/i.test(msg))
    return "Approval required — request sent";
  if (code === "USER_ALREADY_PARTICIPANT" || /already[_ ]?participant|already a member/i.test(msg))
    return "Already a member";
  if (input.floodSeconds || /FLOOD_WAIT/i.test(msg))
    return `Rate-limited by Telegram${input.floodSeconds ? ` (${input.floodSeconds}s)` : ""}`;
  if (code === "INVITE_HASH_EXPIRED" || /INVITE_HASH_EXPIRED/i.test(msg))
    return "Invite link expired";
  if (code === "INVITE_HASH_INVALID" || /INVITE_HASH_INVALID/i.test(msg))
    return "Invite link invalid";
  if (code === "CHANNEL_PRIVATE" || /CHANNEL_PRIVATE/i.test(msg))
    return "Channel is private — no access";
  if (code === "CHANNELS_TOO_MUCH" || /CHANNELS_TOO_MUCH/i.test(msg))
    return "Account is in too many channels (500 cap)";
  if (code === "USER_BANNED_IN_CHANNEL" || /USER_BANNED_IN_CHANNEL/i.test(msg))
    return "This account is banned from the channel";
  if (code === "USER_RESTRICTED" || /USER_RESTRICTED/i.test(msg))
    return "This account is restricted by Telegram";
  if (code === "USERNAME_NOT_OCCUPIED" || /USERNAME_NOT_OCCUPIED/i.test(msg))
    return "Username does not exist";
  if (code === "USERNAME_INVALID" || /USERNAME_INVALID/i.test(msg))
    return "Username is invalid";
  if (code === "PEER_ID_INVALID" || /PEER_ID_INVALID/i.test(msg))
    return "Target could not be resolved";
  if (/JOIN_NOT_VERIFIED/i.test(msg))
    return "Join attempted but membership could not be verified";
  if (/JOIN_TIMEOUT/i.test(msg))
    return "Join timed out";
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(msg))
    return "Account session revoked — reconnect it";
  if (/USER_DEACTIVATED/i.test(msg))
    return "Account was deactivated by Telegram";
  if (/skipped_cached|already cached/i.test(msg))
    return "Skipped — already joined in a prior run";
  if (/skipped_locked|in-flight/i.test(msg))
    return "Skipped — another worker is joining this channel";
  return null;
}