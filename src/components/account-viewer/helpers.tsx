import { cn } from "@/lib/utils";

export function initials(s: string) {
  return s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}

export function fmtTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDay(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export function fmtDialogTime(ms: number | null) {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(ms);
  const diff = (today.getTime() - ms) / 86400000;
  if (diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

export function Avatar({
  photoDataUrl, fallback, kind, size,
}: {
  photoDataUrl: string | null;
  fallback: string;
  kind: "user" | "channel" | "group";
  size: number;
}) {
  const dim = `${size * 0.25}rem`;
  const bg = kind === "channel" ? "bg-blue-600" : kind === "group" ? "bg-green-600" : "bg-purple-600";
  if (photoDataUrl) {
    return (
      <img
        src={photoDataUrl}
        alt=""
        className="shrink-0 rounded-full object-cover"
        style={{ width: dim, height: dim }}
      />
    );
  }
  return (
    <div
      className={cn("flex shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white", bg)}
      style={{ width: dim, height: dim }}
    >
      {fallback}
    </div>
  );
}