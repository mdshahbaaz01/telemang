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

function nowTime(): string {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ap = h >= 12 ? "PM" : "AM";
  return `${hh}:${m} ${ap}`;
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

export function buildChannelViewSvg(info: ChannelInfo, messages: ChannelMessage[] = []): string {
  const W = 720;
  const H = 1280;
  const title = esc(info.title);
  const subs = esc(formatSubs(info.subscribers));
  const avColor = avatarColor(info.title);
  const av = esc(initials(info.title));
  const time = esc(nowTime());

  // Message bubbles rendered from bottom-up, above the "You joined" pill
  const bubbleAreaBottom = H - 300; // above joined pill (which sits at H - 260)
  const bubbleAreaTop = 330;
  const bubbleMaxW = W - 80;
  const lineH = 30;
  const padX = 22;
  const padY = 18;
  const gap = 12;
  const bubbles: string[] = [];
  let y = bubbleAreaBottom;
  const msgs = messages.slice(-6);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const lines = wrapText(m.text || "…", 40, 4);
    const bh = padY * 2 + lines.length * lineH + 26; // extra for footer time
    const bw = Math.min(bubbleMaxW, Math.max(220, ...lines.map((l) => l.length * 12 + padX * 2)));
    const top = y - bh;
    if (top < bubbleAreaTop) break;
    const textEls = lines
      .map((l, li) => `<text x="${padX}" y="${padY + (li + 1) * lineH - 6}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#ffffff">${esc(l)}</text>`)
      .join("");
    const footer = `<text x="${bw - padX}" y="${bh - 12}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#7d95a8">${m.views ? `👁 ${m.views >= 1000 ? (m.views / 1000).toFixed(1).replace(/\.0$/, "") + "K" : m.views}  ` : ""}${esc(m.time)}</text>`;
    bubbles.push(`<g transform="translate(40, ${top})"><rect width="${bw}" height="${bh}" rx="14" ry="14" fill="#182533"/>${textEls}${footer}</g>`);
    y = top - gap;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f2438"/>
      <stop offset="1" stop-color="#0a1826"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="36" y="42" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="600" fill="#ffffff">${time}</text>
  <text x="${W - 36}" y="42" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#ffffff">5G ▲ 84%</text>
  <rect x="0" y="70" width="${W}" height="140" fill="#17212b"/>
  <text x="24" y="130" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#5eb0ef">‹ Back</text>
  <circle cx="${W/2}" cy="150" r="42" fill="${avColor}"/>
  <text x="${W/2}" y="164" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="600" fill="#ffffff">${av}</text>
  <rect x="0" y="210" width="${W}" height="${H - 210 - 200}" fill="#0e1621"/>
  <text x="${W/2}" y="252" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${title}</text>
  <text x="${W/2}" y="286" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#7d8e9c">${subs}</text>
  ${bubbles.join("\n")}
  <g transform="translate(${W/2}, ${H - 260})">
    <rect x="-180" y="-30" width="360" height="60" rx="30" ry="30" fill="rgba(0,0,0,0.5)"/>
    <text x="0" y="8" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="600" fill="#ffffff">You joined this channel</text>
  </g>
  <rect x="0" y="${H - 200}" width="${W}" height="120" fill="#17212b"/>
  <text x="${W/2}" y="${H - 128}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#5eb0ef" letter-spacing="2">🔔  UNMUTE</text>
  <rect x="${W/2 - 70}" y="${H - 22}" width="140" height="6" rx="3" fill="#ffffff" opacity="0.6"/>
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
  { text: "New drop coming this weekend — details tomorrow 🔥", time: "10:04 AM", views: 3800 },
  { text: "Thanks for 10K subscribers 🎉", time: "11:20 AM", views: 2100 },
];