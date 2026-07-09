import { useEffect, useState } from "react";

function formatDuration(totalSec: number) {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

/**
 * Renders a live-updating FloodWait countdown while `pausedUntil` is in the
 * future. Once the pause expires, renders nothing so the row visually returns
 * to normal — no stale "FloodWait 4s" text. When there is a non-flood error
 * (`lastError` present but no active pause), it is shown as a subtle line.
 */
export function FloodWaitBadge({
  pausedUntil,
  lastError,
  compact = false,
}: {
  pausedUntil: string | null | undefined;
  lastError: string | null | undefined;
  compact?: boolean;
}) {
  const target = pausedUntil ? new Date(pausedUntil).getTime() : 0;
  const [now, setNow] = useState(() => Date.now());
  const remaining = Math.max(0, Math.ceil((target - now) / 1000));
  const active = target > 0 && remaining > 0;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  if (active) {
    return (
      <span
        className={
          "inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 font-mono text-destructive " +
          (compact ? "text-[10px]" : "text-xs")
        }
        title={`Telegram rate limit until ${new Date(target).toLocaleString()}`}
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" />
        FloodWait {formatDuration(remaining)}
      </span>
    );
  }

  // Pause expired — hide FloodWait-style errors so the card returns to normal.
  if (!lastError) return null;
  if (/flood[_ ]?wait/i.test(lastError)) return null;
  return <span className={compact ? "text-[10px] text-destructive" : "text-xs text-destructive"}>{lastError}</span>;
}