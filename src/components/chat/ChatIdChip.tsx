import { chatViewer } from "./chat-viewer-store";
import { MessageSquare } from "lucide-react";

export function ChatIdChip({
  id,
  label,
  className,
  accountId,
}: {
  id: string;
  label?: string;
  className?: string;
  accountId?: string;
}) {
  if (!id) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        chatViewer.open(id, accountId ?? null);
      }}
      className={
        "inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary hover:bg-primary/20 transition-colors max-w-full truncate " +
        (className ?? "")
      }
      title={`Open ${id} in Telegram-style viewer`}
    >
      <MessageSquare className="h-3 w-3 shrink-0" />
      <span className="truncate">{label ?? id}</span>
    </button>
  );
}