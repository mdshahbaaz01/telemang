export type Dialog = {
  peerKey: string;
  title: string;
  username: string | null;
  kind: "user" | "channel" | "group";
  unread: number;
  pinned: boolean;
  lastMessagePreview: string;
  lastMessageDate: number | null;
  isSelf: boolean;
  verified: boolean;
  isChannel: boolean;
  photoDataUrl: string | null;
};

export type Message = {
  id: number;
  date: number;
  text: string;
  out: boolean;
  fromKey: string | null;
  replyTo: number | null;
  editDate: number | null;
  mediaKind: string | null;
  photoDataUrl: string | null;
  reactions: { emoji: string; count: number; chosen: boolean }[];
  views: number | null;
  replyMarkup?: ReplyMarkup | null;
};

export type ReplyMarkup =
  | { kind: "inline"; rows: InlineButton[][] }
  | { kind: "keyboard"; rows: InlineButton[][]; oneTime?: boolean; resize?: boolean; placeholder?: string }
  | { kind: "hide" }
  | { kind: "forceReply"; placeholder?: string };

export type InlineButton =
  | { kind: "callback"; text: string; data: string; requiresPassword?: boolean }
  | { kind: "url"; text: string; url: string }
  | { kind: "urlAuth"; text: string; url: string; buttonId?: number }
  | { kind: "switchInline"; text: string; query: string; samePeer: boolean }
  | { kind: "webview"; text: string; url?: string }
  | { kind: "game"; text: string }
  | { kind: "buy"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "other"; text: string; className: string };

export const QUICK_REACTIONS = ["👍", "❤️", "🔥", "🎉", "😂", "😢", "🙏", "👎"];