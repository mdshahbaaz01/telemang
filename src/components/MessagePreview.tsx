import { useMemo, useState } from "react";
import { Eye, EyeOff, Paperclip } from "lucide-react";
import { formatMessage, type MessageFormat } from "@/lib/message-format";

const ALLOWED_TAGS = new Set([
  "B","STRONG","I","EM","U","INS","S","STRIKE","DEL","CODE","PRE","BLOCKQUOTE","A","BR",
]);

function sanitize(html: string): string {
  if (typeof window === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  const walk = (node: Element) => {
    // Iterate children safely (live collection)
    const children = Array.from(node.children);
    for (const child of children) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        // Replace disallowed element with its text content
        child.replaceWith(doc.createTextNode(child.textContent ?? ""));
        continue;
      }
      // Strip attributes except href on <a>
      const attrs = Array.from(child.attributes);
      for (const a of attrs) {
        if (child.tagName === "A" && a.name === "href") {
          const v = a.value.trim().toLowerCase();
          if (v.startsWith("javascript:") || v.startsWith("data:")) {
            child.removeAttribute(a.name);
          }
          continue;
        }
        child.removeAttribute(a.name);
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

export function MessagePreview({
  message,
  format,
  fileName,
  defaultOpen = false,
}: {
  message: string;
  format: MessageFormat;
  fileName?: string | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { html, isHtml } = useMemo(() => {
    const trimmed = message ?? "";
    const f = formatMessage(trimmed, format);
    if (f.parseMode === "html") {
      return { html: sanitize(f.message), isHtml: true };
    }
    return { html: f.message, isHtml: false };
  }, [message, format]);

  const empty = !message?.trim() && !fileName;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
      >
        {open ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        {open ? "Hide preview" : "Show preview"}
      </button>
      {open && (
        <div className="mt-1 max-w-md rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2 text-sm shadow-sm">
          {empty ? (
            <span className="text-xs italic text-muted-foreground">Nothing to preview yet</span>
          ) : (
            <>
              {fileName && (
                <div className="mb-1 flex items-center gap-2 rounded-md border border-border bg-background/70 px-2 py-1 text-xs">
                  <Paperclip className="h-3 w-3 text-muted-foreground" />
                  <span className="truncate">{fileName}</span>
                </div>
              )}
              {isHtml ? (
                <div
                  className="prose prose-sm max-w-none whitespace-pre-wrap break-words [&_pre]:whitespace-pre-wrap [&_code]:rounded [&_code]:bg-background/70 [&_code]:px-1 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-2 [&_blockquote]:italic"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              ) : (
                <div className="whitespace-pre-wrap break-words">{html}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}