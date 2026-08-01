/**
 * Canonical join-target keys (duplicate-target collapsing).
 *
 * `@name`, `t.me/name`, `https://telegram.me/name/42`, `t.me/+hash`,
 * `t.me/joinchat/hash` and `t.me/c/123456/7` all normalize to one stable key
 * so counts, caches, fingerprints and "already member" checks agree.
 *
 * Invite hashes keep their original case (Telegram invite hashes are
 * case-sensitive); usernames are lowercased.
 */
export type CanonicalTarget = {
  key: string;
  kind: "username" | "invite" | "internal_id" | "raw";
  /** Value usable for a Telegram API call (username, +hash, or numeric id). */
  value: string;
};

const URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:t(?:elegram)?\.me)\//i;

export function canonicalizeJoinTarget(raw: string): CanonicalTarget {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/^[<([]|[>)\]]$/g, "")
    .replace(/[?#].*$/, "")
    .replace(URL_PREFIX, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");

  if (!cleaned) return { key: "", kind: "raw", value: "" };

  if (/^joinchat\//i.test(cleaned)) {
    const hash = cleaned.slice("joinchat/".length).split("/")[0] ?? "";
    return { key: `invite:${hash}`, kind: "invite", value: `+${hash}` };
  }
  if (cleaned.startsWith("+")) {
    const hash = cleaned.slice(1).split("/")[0] ?? "";
    return { key: `invite:${hash}`, kind: "invite", value: `+${hash}` };
  }
  const internal = cleaned.match(/^c\/(\d+)(?:\/\d+)?$/i);
  if (internal) {
    return { key: `id:${internal[1]}`, kind: "internal_id", value: internal[1]! };
  }
  const withPost = cleaned.match(/^([A-Za-z0-9_]{3,32})(?:\/\d+)*$/);
  if (withPost) {
    const name = withPost[1]!.toLowerCase();
    return { key: `user:${name}`, kind: "username", value: name };
  }
  return { key: `raw:${cleaned.toLowerCase()}`, kind: "raw", value: cleaned };
}

export function joinTargetKey(raw: string): string {
  return canonicalizeJoinTarget(raw).key;
}

/** Collapse a list of mixed links into unique canonical targets (first form wins). */
export function collapseJoinTargets(raws: string[]): { key: string; raw: string }[] {
  const seen = new Map<string, string>();
  for (const raw of raws) {
    const { key } = canonicalizeJoinTarget(raw);
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.entries()].map(([key, raw]) => ({ key, raw }));
}