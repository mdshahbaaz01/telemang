import { useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, Loader2, Reply, Smile, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/clipboard";
import { fmtTime } from "./helpers";
import { QUICK_REACTIONS, type InlineButton, type Message } from "./types";

export function MessageRow({
  msg, parentReply, onReply, onReact, onDelete, isOwn, canModify, onPressButton, pressingKey,
}: {
  msg: Message;
  parentReply: Message | null;
  onReply: () => void;
  onReact: (msg: Message, emoji: string | null) => void;
  onDelete: (msg: Message) => void;
  isOwn: boolean;
  canModify: boolean;
  onPressButton: (msg: Message, btn: InlineButton, key: string) => void;
  pressingKey: string | null;
}) {
  const [showReactions, setShowReactions] = useState(false);
  return (
    <div className={cn("group flex", isOwn ? "justify-end" : "justify-start")}>
      <div className={cn(
        "relative max-w-[70%] rounded-2xl px-3 py-1.5 text-sm",
        isOwn ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-card border",
      )}>
        {parentReply && (
          <div className={cn("mb-1 border-l-2 pl-2 text-xs opacity-80", isOwn ? "border-primary-foreground/60" : "border-primary")}>
            <div className="font-semibold">Reply</div>
            <div className="line-clamp-2">{parentReply.text || "[media]"}</div>
          </div>
        )}
        {msg.mediaKind === "photo" && msg.photoDataUrl && (
          <img src={msg.photoDataUrl} alt="" className="mb-1 max-h-64 rounded" />
        )}
        {msg.mediaKind && msg.mediaKind !== "photo" && !msg.text && (
          <div className="italic opacity-70">📎 {msg.mediaKind}</div>
        )}
        {msg.text && <div className="whitespace-pre-wrap break-words">{msg.text}</div>}
        <div className={cn("mt-0.5 flex items-center gap-1 text-[10px]", isOwn ? "text-primary-foreground/80" : "text-muted-foreground")}>
          {msg.editDate && <span>edited</span>}
          {msg.views != null && <span>{msg.views} views</span>}
          <span>{fmtTime(msg.date)}</span>
        </div>
        {msg.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {msg.reactions.map((r, i) => (
              <button
                key={i}
                onClick={() => onReact(msg, r.chosen ? null : r.emoji)}
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[10px]",
                  r.chosen ? "bg-primary/20 border-primary" : "bg-background",
                )}
              >
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}

        {msg.replyMarkup && (msg.replyMarkup.kind === "inline" || msg.replyMarkup.kind === "keyboard") && msg.replyMarkup.rows.length > 0 && (
          <div className="mt-2 space-y-1">
            {msg.replyMarkup.rows.map((row, ri) => (
              <div key={ri} className="flex flex-wrap gap-1">
                {row.map((btn, ci) => {
                  const key = `${msg.id}:${ri}:${ci}`;
                  const busy = pressingKey === key;
                  const clickable =
                    btn.kind === "callback" ||
                    btn.kind === "url" ||
                    btn.kind === "urlAuth" ||
                    btn.kind === "webview" ||
                    btn.kind === "requestPhone" ||
                    btn.kind === "reply";
                  const title =
                    btn.kind === "url" || btn.kind === "urlAuth"
                      ? `Opens: ${(btn as { url?: string }).url ?? ""}`
                      : btn.kind === "callback"
                        ? "Callback button"
                        : btn.kind === "webview"
                          ? "Opens a Telegram WebApp (limited)"
                          : btn.kind === "requestPhone"
                            ? "Shares this account profile/contact"
                          : btn.kind === "reply"
                            ? `Sends: ${btn.text}`
                          : `${btn.kind} button (not supported)`;
                  const urlValue = (btn.kind === "url" || btn.kind === "urlAuth")
                    ? (btn as { url?: string }).url ?? ""
                    : "";
                  return (
                    <button
                      key={ci}
                      type="button"
                      title={title}
                      disabled={!clickable || busy}
                      onClick={() => onPressButton(msg, btn, key)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                        clickable
                          ? isOwn
                            ? "border-primary-foreground/40 bg-primary-foreground/10 hover:bg-primary-foreground/20"
                            : "border-primary/40 bg-primary/10 hover:bg-primary/20"
                          : "cursor-not-allowed border-border bg-muted opacity-60",
                      )}
                    >
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      {(btn.kind === "url" || btn.kind === "urlAuth") && (
                        <ExternalLink className="h-3 w-3" />
                      )}
                      <span className="max-w-[16rem] truncate">{btn.text}</span>
                      {urlValue && (
                        <span
                          role="button"
                          tabIndex={0}
                          title="Copy link"
                          className="ml-1 rounded p-0.5 hover:bg-background/40"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyWithToast(urlValue, toast);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation();
                              copyWithToast(urlValue, toast);
                            }
                          }}
                        >
                          <Copy className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className={cn(
          "absolute top-0 flex items-center gap-1 opacity-0 transition group-hover:opacity-100",
          isOwn ? "-left-24" : "-right-24",
        )}>
          <button className="rounded bg-background p-1 shadow-sm hover:bg-muted" onClick={() => setShowReactions((v) => !v)} title="React">
            <Smile className="h-3.5 w-3.5" />
          </button>
          <button className="rounded bg-background p-1 shadow-sm hover:bg-muted" onClick={onReply} title="Reply">
            <Reply className="h-3.5 w-3.5" />
          </button>
          {canModify && (
            <button className="rounded bg-background p-1 shadow-sm hover:bg-muted text-red-500" onClick={() => onDelete(msg)} title="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {showReactions && (
          <div className={cn("absolute z-10 flex gap-1 rounded-full border bg-background p-1 shadow-md", isOwn ? "-top-9 right-0" : "-top-9 left-0")}>
            {QUICK_REACTIONS.map((e) => (
              <button key={e} onClick={() => { onReact(msg, e); setShowReactions(false); }} className="rounded-full px-1.5 py-0.5 text-base hover:bg-muted">
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}