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