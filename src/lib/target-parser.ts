export type ParsedTargetKind =
  | "username"
  | "invite"
  | "post"
  | "id"
  | "phone"
  | "junk";

export type ParsedTargetItem = {
  raw: string;
  kind: ParsedTargetKind;
  normalized: string;
  channel?: string;
  messageId?: number;
};

const URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i;

export function parseMixedTargets(text: string): ParsedTargetItem[] {
  if (!text) return [];
  const lines = text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: ParsedTargetItem[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const item = classify(raw);
    const key = `${item.kind}:${item.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function classify(raw: string): ParsedTargetItem {
  const cleaned = raw.replace(/^[<(\[]|[>)\]]$/g, "").trim();
  if (/^\+?\d{7,15}$/.test(cleaned) && cleaned.startsWith("+")) {
    return { raw, kind: "phone", normalized: cleaned };
  }
  if (/^-?\d{5,}$/.test(cleaned)) {
    return { raw, kind: "id", normalized: cleaned };
  }
  const stripped = cleaned.replace(URL_PREFIX, "").replace(/^@/, "");
  if (!stripped) return { raw, kind: "junk", normalized: raw };

  // Invite link: +HASH or joinchat/HASH
  if (stripped.startsWith("+")) {
    return { raw, kind: "invite", normalized: `+${stripped.slice(1).split(/[/?#]/)[0]}` };
  }
  if (/^joinchat\//i.test(stripped)) {
    const hash = stripped.slice("joinchat/".length).split(/[/?#]/)[0];
    return { raw, kind: "invite", normalized: `+${hash}` };
  }

  // Post link: username/123 or c/123456/456
  const postMatch = stripped.match(/^([A-Za-z0-9_]{3,})\/(\d+)(?:\/(\d+))?$/);
  if (postMatch) {
    const [, channel, a, b] = postMatch;
    const messageId = b ? Number(b) : Number(a);
    return { raw, kind: "post", normalized: `${channel}/${messageId}`, channel, messageId };
  }

  if (/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(stripped)) {
    return { raw, kind: "username", normalized: stripped.toLowerCase() };
  }
  return { raw, kind: "junk", normalized: raw };
}

export function groupParsed(items: ParsedTargetItem[]) {
  const groups: Record<ParsedTargetKind, ParsedTargetItem[]> = {
    username: [], invite: [], post: [], id: [], phone: [], junk: [],
  };
  for (const it of items) groups[it.kind].push(it);
  return groups;
}