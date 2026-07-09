import { useEffect, useMemo, useState } from "react";
import { Eye, Paperclip, FileIcon } from "lucide-react";
import { formatMessage, type MessageFormat } from "@/lib/message-format";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
  files,
  defaultOpen = false,
}: {
  message: string;
  format: MessageFormat;
  fileName?: string | null;
  files?: File[];
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

  const [thumbs, setThumbs] = useState<Array<{ name: string; url?: string; kind: "image" | "video" | "audio" | "other" }>>([]);
  useEffect(() => {
    if (!files?.length) {
      setThumbs([]);
      return;
    }
    const items = files.map((f) => {
      const kind: "image" | "video" | "audio" | "other" = f.type.startsWith("image/")
        ? "image"
        : f.type.startsWith("video/")
          ? "video"
          : f.type.startsWith("audio/")
            ? "audio"
            : "other";
      const url = kind === "image" || kind === "video" ? URL.createObjectURL(f) : undefined;
      return { name: f.name, url, kind };
    });
    setThumbs(items);
    return () => {
      for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
    };
  }, [files]);

  const empty = !message?.trim() && !fileName && !(files && files.length);

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
      >
        <Eye className="h-3 w-3" />
        Preview message
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Message preview</DialogTitle>
          </DialogHeader>
          <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2 text-sm shadow-sm">
            {empty ? (
              <span className="text-xs italic text-muted-foreground">Nothing to preview yet</span>
            ) : (
              <>
                {thumbs.length > 0 && (
                  <div className={`mb-2 grid gap-1 ${thumbs.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
                    {thumbs.map((t, i) => (
                      <div key={i} className="relative overflow-hidden rounded-md border border-border bg-background/70">
                        {t.kind === "image" && t.url ? (
                          <img src={t.url} alt={t.name} className="h-40 w-full object-cover" />
                        ) : t.kind === "video" && t.url ? (
                          <video src={t.url} className="h-40 w-full object-cover" muted />
                        ) : (
                          <div className="flex h-40 flex-col items-center justify-center gap-1 p-2 text-xs text-muted-foreground">
                            <FileIcon className="h-6 w-6" />
                            <span className="truncate max-w-full">{t.name}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {!thumbs.length && fileName && (
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
                  <div className="whitespace-pre-wrap break-words">{html || <span className="text-xs italic text-muted-foreground">(no caption)</span>}</div>
                )}
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Formatting applied here matches both immediate and scheduled sends.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}