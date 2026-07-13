import { useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AtSign, Hash, Link2, Phone, MessageSquare, AlertCircle } from "lucide-react";
import { parseMixedTargets, groupParsed, type ParsedTargetKind } from "@/lib/target-parser";

const ICONS: Record<ParsedTargetKind, React.ComponentType<{ className?: string }>> = {
  username: AtSign,
  invite: Link2,
  post: MessageSquare,
  id: Hash,
  phone: Phone,
  junk: AlertCircle,
};

const LABELS: Record<ParsedTargetKind, string> = {
  username: "Usernames",
  invite: "Invite links",
  post: "Post links",
  id: "IDs",
  phone: "Phones",
  junk: "Unrecognized",
};

type Props = {
  onApply: (grouped: {
    usernames: string[];
    invites: string[];
    posts: { channel: string; messageId: number }[];
    ids: string[];
    phones: string[];
  }) => void;
  placeholder?: string;
};

export function PastedTargetsBox({ onApply, placeholder }: Props) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseMixedTargets(text), [text]);
  const groups = useMemo(() => groupParsed(parsed), [parsed]);
  const kinds: ParsedTargetKind[] = ["username", "invite", "post", "id", "phone", "junk"];

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <Textarea
        rows={4}
        placeholder={placeholder ?? "Paste anything — usernames, invite links, post links, IDs, phones. Auto-classified below."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="font-mono text-xs"
      />
      {parsed.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {kinds.map((k) => {
              const count = groups[k].length;
              if (!count) return null;
              const Icon = ICONS[k];
              return (
                <Badge key={k} variant={k === "junk" ? "destructive" : "secondary"} className="gap-1">
                  <Icon className="h-3 w-3" /> {LABELS[k]} · {count}
                </Badge>
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setText("")}
              disabled={!text}
            >
              Clear
            </Button>
            <Button
              size="sm"
              onClick={() =>
                onApply({
                  usernames: groups.username.map((i) => i.normalized),
                  invites: groups.invite.map((i) => i.normalized),
                  posts: groups.post
                    .filter((i) => i.channel && i.messageId)
                    .map((i) => ({ channel: i.channel!, messageId: i.messageId! })),
                  ids: groups.id.map((i) => i.normalized),
                  phones: groups.phone.map((i) => i.normalized),
                })
              }
              disabled={parsed.every((i) => i.kind === "junk")}
            >
              Apply {parsed.filter((i) => i.kind !== "junk").length}
            </Button>
          </div>
          {groups.junk.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Skipped: {groups.junk.map((i) => i.raw).slice(0, 5).join(", ")}
              {groups.junk.length > 5 && ` +${groups.junk.length - 5} more`}
            </div>
          )}
        </>
      )}
    </div>
  );
}