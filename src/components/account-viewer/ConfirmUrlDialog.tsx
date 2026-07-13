import { toast } from "sonner";
import { Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyWithToast } from "@/lib/clipboard";

export function ConfirmUrlDialog({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-semibold">Open external link?</div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            title="Copy link"
            onClick={() => copyWithToast(url, toast)}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mb-3 break-all rounded-md border bg-muted p-2 text-xs">{url}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={() => copyWithToast(url, toast)}>
            <Copy className="mr-1 h-4 w-4" /> Copy
          </Button>
          <Button
            size="sm"
            onClick={() => {
              window.open(url, "_blank", "noopener,noreferrer");
              onClose();
            }}
          >
            <ExternalLink className="mr-1 h-4 w-4" /> Open
          </Button>
        </div>
      </div>
    </div>
  );
}