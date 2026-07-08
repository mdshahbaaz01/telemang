// Pure SVG builders — safe to import in both client and server code.

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function avatarColor(seed: string): string {
  const colors = [
    "#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae",
    "#6ec9cb", "#faa774", "#7fbf72", "#5eb2d2", "#c689c6",
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function fmtTime(d: Date = new Date()): string {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ap = h >= 12 ? "PM" : "AM";
  return `${hh}:${m} ${ap}`;
}
const nowTime = () => fmtTime();

function fmtViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function formatSubs(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M subscribers";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K subscribers";
  return `${n} subscribers`;
}

export type ChannelInfo = {
  title: string;
  username?: string | null;
  subscribers: number;
  verified?: boolean;
  /** Base64-encoded PNG/JPEG of the channel avatar, no data-URI prefix. */
  avatarBase64?: string | null;
  avatarMime?: string;
};

export type OtherDialog = {
  title: string;
  lastMessage: string;
  time: string;
  unread?: number;
};

export type ChannelMessage = {
  text: string;
  time: string;
  views?: number;
  forwardedFrom?: string | null;
  mediaKind?: "photo" | "video" | "document" | "poll" | "sticker" | "audio" | null;
  mediaLabel?: string | null;
};

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = (cur ? cur + " " : "") + w;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, "…");
  }
  return lines;
}

function mediaIconLabel(kind: NonNullable<ChannelMessage["mediaKind"]>, label?: string | null): string {
  const base: Record<string, string> = {
    photo: "🖼  Photo",
    video: "🎬  Video",
    document: "📎  Document",
    poll: "📊  Poll",
    sticker: "🎨  Sticker",
    audio: "🎧  Voice message",
  };
  return label ? `${base[kind].split("  ")[0]}  ${label}` : base[kind];
}

export function buildChannelViewSvg(
  info: ChannelInfo,
  messages: ChannelMessage[] = [],
  opts: { joinedAt?: Date; deviceTime?: Date } = {},
): string {
  const W = 720;
  const H = 1480;
  const title = esc(info.title);
  const subs = esc(formatSubs(info.subscribers));
  const avColor = avatarColor(info.title);
  const av = esc(initials(info.title));
  const deviceTime = esc(fmtTime(opts.deviceTime));
  const joinedTime = esc(fmtTime(opts.joinedAt));

  // Layout regions
  const STATUS_H = 56;
  const HEADER_TOP = STATUS_H;
  const HEADER_H = 120;
  const HEADER_BOTTOM = HEADER_TOP + HEADER_H;
  const FOOTER_H = 110;
  const HOME_H = 40;
  const CHAT_TOP = HEADER_BOTTOM + 20;
  const CHAT_BOTTOM = H - FOOTER_H - HOME_H - 10;

  // Header (avatar left, title + subs stacked)
  const avR = 42;
  const avCx = 132;
  const avCy = HEADER_TOP + HEADER_H / 2;
  const headerAvatar = info.avatarBase64
    ? `<defs><clipPath id="avClip"><circle cx="${avCx}" cy="${avCy}" r="${avR}"/></clipPath></defs>
       <image href="data:${info.avatarMime || "image/jpeg"};base64,${info.avatarBase64}" x="${avCx - avR}" y="${avCy - avR}" width="${avR * 2}" height="${avR * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avClip)"/>`
    : `<circle cx="${avCx}" cy="${avCy}" r="${avR}" fill="${avColor}"/>
       <text x="${avCx}" y="${avCy + 12}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="32" font-weight="600" fill="#ffffff">${av}</text>`;

  const titleX = avCx + avR + 20;
  const verifiedBadge = info.verified
    ? `<g transform="translate(${titleX + Math.min(title.length * 15, 340)}, ${avCy - 18})">
         <circle cx="14" cy="14" r="14" fill="#5eb0ef"/>
         <text x="14" y="20" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="700" fill="#ffffff">✓</text>
       </g>`
    : "";

  // Messages stacked top-down inside chat area
  const bubbleLeft = 24;
  const bubbleMaxW = W - bubbleLeft * 2;
  const lineH = 30;
  const padX = 20;
  const padY = 16;
  const gap = 14;
  const bubbleParts: string[] = [];
  let y = CHAT_TOP;
  const joinReserve = 90; // room for join pill

  const msgs = messages.slice(-6);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const hasMedia = !!m.mediaKind;
    const mediaLine = hasMedia ? mediaIconLabel(m.mediaKind!, m.mediaLabel) : null;
    const fwdLine = m.forwardedFrom ? `Forwarded from ${m.forwardedFrom}` : null;
    const textLines = m.text ? wrapText(m.text, 42, hasMedia ? 3 : 5) : [];

    // Estimate width from longest line
    const allLines = [
      ...(fwdLine ? [fwdLine] : []),
      ...(mediaLine ? [mediaLine] : []),
      ...textLines,
    ];
    const longest = allLines.reduce((mx, l) => Math.max(mx, l.length), 0);
    const bw = Math.min(bubbleMaxW, Math.max(260, longest * 13 + padX * 2));

    let bh = padY * 2 + 30; // footer time
    let cursorY = padY + 4;
    const inner: string[] = [];

    if (fwdLine) {
      inner.push(`<text x="${padX}" y="${cursorY + 20}" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="600" fill="#5eb0ef">${esc(fwdLine)}</text>`);
      cursorY += 32;
      bh += 32;
    }
    if (mediaLine) {
      // Rounded tile
      inner.push(`<rect x="${padX}" y="${cursorY}" width="${bw - padX * 2}" height="60" rx="10" fill="#0f1c28"/>`);
      inner.push(`<text x="${padX + 16}" y="${cursorY + 38}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#a6c5db">${esc(mediaLine)}</text>`);
      cursorY += 72;
      bh += 72;
    }
    for (const line of textLines) {
      inner.push(`<text x="${padX}" y="${cursorY + 22}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#ffffff">${esc(line)}</text>`);
      cursorY += lineH;
      bh += lineH;
    }

    const footerParts: string[] = [];
    if (m.views) footerParts.push(`👁 ${fmtViews(m.views)}`);
    footerParts.push(m.time);
    const footer = `<text x="${bw - padX}" y="${bh - 14}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#7d95a8">${esc(footerParts.join("  ·  "))}</text>`;

    if (y + bh + joinReserve > CHAT_BOTTOM) break;

    bubbleParts.push(`<g transform="translate(${bubbleLeft}, ${y})">
      <rect width="${bw}" height="${bh}" rx="16" ry="16" fill="#182533"/>
      ${inner.join("\n      ")}
      ${footer}
    </g>`);
    y += bh + gap;
  }

  // Join service pill just below last message (or at bottom of chat if no msgs)
  const joinY = Math.max(y + 10, CHAT_BOTTOM - 60);
  const joinPill = `<g transform="translate(${W / 2}, ${joinY})">
    <rect x="-200" y="-24" width="400" height="48" rx="24" fill="rgba(0,0,0,0.55)"/>
    <text x="0" y="8" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="600" fill="#ffffff">You joined this channel · ${joinedTime}</text>
  </g>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- chat background -->
  <rect width="${W}" height="${H}" fill="#0e1621"/>

  <!-- status bar -->
  <rect width="${W}" height="${STATUS_H}" fill="#0e1621"/>
  <text x="36" y="38" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="#ffffff">${deviceTime}</text>
  <g transform="translate(${W - 170}, 22)" fill="#ffffff">
    <!-- signal dots -->
    <circle cx="0" cy="10" r="3"/><circle cx="10" cy="10" r="3"/><circle cx="20" cy="10" r="3"/><circle cx="30" cy="10" r="3" opacity="0.4"/>
    <text x="46" y="16" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600">5G</text>
    <!-- battery -->
    <rect x="86" y="2" width="46" height="20" rx="4" fill="none" stroke="#ffffff" stroke-width="1.5"/>
    <rect x="88" y="4" width="36" height="16" rx="2" fill="#ffffff"/>
    <rect x="132" y="8" width="3" height="8" fill="#ffffff"/>
  </g>

  <!-- header -->
  <rect x="0" y="${HEADER_TOP}" width="${W}" height="${HEADER_H}" fill="#17212b"/>
  <text x="24" y="${HEADER_TOP + HEADER_H / 2 + 8}" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#5eb0ef">‹</text>
  ${headerAvatar}
  <text x="${titleX}" y="${avCy - 4}" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#ffffff">${title}</text>
  ${verifiedBadge}
  <text x="${titleX}" y="${avCy + 28}" font-family="Helvetica, Arial, sans-serif" font-size="19" fill="#7d8e9c">${subs}</text>
  <text x="${W - 28}" y="${HEADER_TOP + HEADER_H / 2 + 10}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#7d8e9c">⋯</text>

  <!-- messages -->
  ${bubbleParts.join("\n  ")}

  <!-- join service pill -->
  ${joinPill}

  <!-- footer -->
  <rect x="0" y="${H - FOOTER_H - HOME_H}" width="${W}" height="${FOOTER_H}" fill="#17212b"/>
  <text x="${W / 2}" y="${H - HOME_H - FOOTER_H / 2 + 10}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="700" fill="#5eb0ef" letter-spacing="2">🔔  UNMUTE</text>

  <!-- home indicator -->
  <rect x="${W / 2 - 70}" y="${H - 18}" width="140" height="6" rx="3" fill="#ffffff" opacity="0.55"/>
</svg>`;
}

export function buildChatListSvg(joined: ChannelInfo, others: OtherDialog[]): string {
  const W = 720;
  const H = 1280;
  const time = esc(nowTime());
  const rowH = 110;
  const startY = 220;

  const list: Array<{ title: string; last: string; time: string; unread?: number; joined?: boolean }> = [];
  list.push({ title: joined.title, last: "You joined this channel", time: nowTime(), joined: true });
  for (const o of others) {
    list.push({ title: o.title, last: o.lastMessage, time: o.time, unread: o.unread });
    if (list.length >= 9) break;
  }

  const rows: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const y = startY + i * rowH;
    const av = esc(initials(it.title));
    const avc = avatarColor(it.title);
    const t = esc(it.title.length > 28 ? it.title.slice(0, 28) + "…" : it.title);
    const lastRaw = it.last.length > 44 ? it.last.slice(0, 44) + "…" : it.last;
    const last = esc(lastRaw);
    const lastColor = it.joined ? "#5eb0ef" : "#7d8e9c";
    rows.push(`
  <g transform="translate(0, ${y})">
    <circle cx="60" cy="50" r="38" fill="${avc}"/>
    <text x="60" y="62" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="600" fill="#ffffff">${av}</text>
    <text x="120" y="42" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600" fill="#ffffff">${t}</text>
    <text x="120" y="78" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="${lastColor}">${last}</text>
    <text x="${W - 24}" y="42" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#7d8e9c">${esc(it.time)}</text>
    ${it.unread ? `<rect x="${W - 80}" y="60" width="56" height="30" rx="15" fill="#5eb0ef"/><text x="${W - 52}" y="82" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700" fill="#0e1621">${it.unread}</text>` : ""}
    <line x1="120" y1="${rowH - 2}" x2="${W}" y2="${rowH - 2}" stroke="#1a2733" stroke-width="1"/>
  </g>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0e1621"/>
  <text x="36" y="42" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="600" fill="#ffffff">${time}</text>
  <text x="${W - 36}" y="42" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#ffffff">5G ▲ 84%</text>
  <rect x="0" y="70" width="${W}" height="90" fill="#17212b"/>
  <text x="24" y="128" font-family="Helvetica, Arial, sans-serif" font-size="32" font-weight="700" fill="#ffffff">Chats</text>
  <text x="${W - 24}" y="128" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#5eb0ef">✎</text>
  <rect x="20" y="170" width="${W - 40}" height="44" rx="10" fill="#1a2733"/>
  <text x="${W/2}" y="199" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#5a6c7d">🔍  Search</text>
  ${rows.join("\n")}
  <rect x="${W/2 - 70}" y="${H - 22}" width="140" height="6" rx="3" fill="#ffffff" opacity="0.6"/>
</svg>`;
}

export const SAMPLE_OTHERS: OtherDialog[] = [
  { title: "Mom", lastMessage: "Call me when you're free 💕", time: "9:42 AM", unread: 2 },
  { title: "Work Team", lastMessage: "Alex: standup in 5", time: "9:15 AM", unread: 12 },
  { title: "Sarah", lastMessage: "Sounds good, see you then!", time: "8:58 AM" },
  { title: "Crypto News", lastMessage: "BTC breaks $95K resistance…", time: "Yesterday" },
  { title: "Gym Buddies", lastMessage: "David: leg day tomorrow?", time: "Yesterday", unread: 1 },
  { title: "Family", lastMessage: "Dad shared a photo", time: "Mon" },
  { title: "Deals & Coupons", lastMessage: "50% off flash sale ends tonight", time: "Sun" },
];

export const SAMPLE_MESSAGES: ChannelMessage[] = [
  { text: "Welcome to the channel! Turn on notifications so you never miss an update.", time: "9:12 AM", views: 4200 },
  { text: "", time: "9:48 AM", views: 3900, mediaKind: "photo", mediaLabel: "cover.jpg" },
  { text: "New drop coming this weekend — details tomorrow 🔥", time: "10:04 AM", views: 3800, forwardedFrom: "Official News" },
  { text: "Thanks for 10K subscribers 🎉", time: "11:20 AM", views: 2100 },
];