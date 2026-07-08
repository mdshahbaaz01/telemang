import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type BroadcastRowInput = {
  accountId: string;
  message: string;
  targets: string[];
  attachment?: { path: string; filename: string; mimeType?: string };
};

export type BroadcastExecInput = {
  rows: BroadcastRowInput[];
  minDelay: number;
  maxDelay: number;
};

export type BroadcastExecResult = {
  ok: number;
  fail: number;
  logs: Array<{ accountId: string | null; target: string | null; level: string; message: string }>;
};

function jitter(min: number, max: number) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo * 1000 + Math.random() * (hi - lo) * 1000;
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * Standalone broadcast executor — mirrors the broadcast branch of
 * /api/public/actions-stream but without SSE, so it can run inside a cron
 * worker for scheduled dispatches. Accuracy note: the *dispatch loop* is
 * fired at the exact millisecond by the caller; per-target jitter delays
 * apply *after* the first message goes out.
 */
export async function executeBroadcast(
  supabase: SupabaseClient<Database>,
  input: BroadcastExecInput,
): Promise<BroadcastExecResult> {
  const { openClientForAccount } = await import("./cleanup.server");
  const { Api } = await import("telegram");
  const { CustomFile } = await import("telegram/client/uploads");

  const logs: BroadcastExecResult["logs"] = [];
  const push = (l: (typeof logs)[number]) => logs.push(l);

  const attachmentCache = new Map<string, { buf: Buffer; filename: string; mimeType?: string }>();
  const loadAttachment = async (att: { path: string; filename: string; mimeType?: string }) => {
    const cached = attachmentCache.get(att.path);
    if (cached) return cached;
    const { data, error } = await supabase.storage
      .from("action-attachments")
      .createSignedUrl(att.path, 300);
    if (error || !data?.signedUrl) throw new Error(`Attachment fetch failed: ${error?.message ?? "no url"}`);
    const res = await fetch(data.signedUrl);
    if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const val = { buf, filename: att.filename, mimeType: att.mimeType };
    attachmentCache.set(att.path, val);
    return val;
  };

  const resolveTarget = async (client: any, t: string) => {
    const cleaned = t.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
    if (/^c\/\d+/.test(cleaned)) {
      const raw = cleaned.split("/")[1];
      const { default: bigInt } = await import("big-integer");
      try {
        return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
      } catch {
        return await client.getEntity(`https://t.me/${cleaned}`);
      }
    }
    return await client.getEntity(cleaned);
  };

  // Group rows by account so each account only connects once.
  const byAccount = new Map<string, BroadcastRowInput[]>();
  for (const row of input.rows) {
    const arr = byAccount.get(row.accountId) ?? [];
    arr.push(row);
    byAccount.set(row.accountId, arr);
  }

  let ok = 0;
  let fail = 0;

  // All accounts fire in parallel so scheduled dispatch is not serialized.
  await Promise.all(
    Array.from(byAccount.entries()).map(async ([accountId, rows]) => {
      let client;
      try {
        client = await openClientForAccount(supabase, accountId);
      } catch (e) {
        const m = `Connect failed: ${errorText(e)}`;
        push({ accountId, target: null, level: "error", message: m });
        fail += rows.reduce((n, r) => n + r.targets.length, 0);
        return;
      }
      try {
        for (const row of rows) {
          let attData: { buf: Buffer; filename: string; mimeType?: string } | null = null;
          if (row.attachment) {
            try {
              attData = await loadAttachment(row.attachment);
            } catch (e) {
              const em = errorText(e);
              fail += row.targets.length;
              push({ accountId, target: null, level: "error", message: em });
              continue;
            }
          }
          for (const t of row.targets) {
            try {
              const dest = await resolveTarget(client, t);
              if (attData) {
                await client.sendFile(dest, {
                  file: new CustomFile(attData.filename, attData.buf.length, attData.filename, attData.buf),
                  caption: row.message || undefined,
                });
              } else {
                await client.sendMessage(dest, { message: row.message });
              }
              ok++;
              push({ accountId, target: t, level: "success", message: `Sent to ${t}` });
            } catch (e) {
              fail++;
              const em = errorText(e);
              push({ accountId, target: t, level: "error", message: em });
            }
            await new Promise((r) => setTimeout(r, jitter(input.minDelay, input.maxDelay)));
          }
        }
      } finally {
        await client.disconnect().catch(() => {});
      }
    }),
  );

  return { ok, fail, logs };
}