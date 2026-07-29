import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseFloodWait } from "./telegram/errors";

const InputSchema = z.object({
  accountId: z.string().uuid(),
  sourcePeerKey: z.string().min(1),
  targetPeerKey: z.string().min(1),
  fromMsgId: z.number().int().min(1),
  toMsgId: z.number().int().min(1),
  dropAuthor: z.boolean().default(false),
  delayMs: z.number().int().min(0).max(60000).default(300),
  markRead: z.boolean().default(true),
});

async function resolvePeer(client: any, Api: any, key: string) {
  if (key.startsWith("@")) return await client.getEntity(key.slice(1));
  const [kind, raw] = key.split(":");
  const { default: bigInt } = await import("big-integer");
  const id = bigInt(raw);
  const peer =
    kind === "u" ? new Api.PeerUser({ userId: id }) :
    kind === "c" ? new Api.PeerChannel({ channelId: id }) :
    kind === "g" ? new Api.PeerChat({ chatId: id }) :
    null;
  if (!peer) throw new Error(`Bad peer key: ${key}`);
  try {
    return await client.getEntity(peer);
  } catch {
    await client.getDialogs({ limit: 500 }).catch(() => {});
    return await client.getEntity(peer);
  }
}

export const forwardMessageRange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => InputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const lo = Math.min(data.fromMsgId, data.toMsgId);
    const hi = Math.max(data.fromMsgId, data.toMsgId);
    if (hi - lo > 5000) throw new Error("Range too large (max 5000 messages).");

    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const { markPeerRead } = await import("./telegram-read-helper.server");

    const client = await openClientForAccount(context.supabase, data.accountId);
    const logs: Array<{ level: "info" | "success" | "warn" | "error"; message: string }> = [];
    let forwarded = 0;
    let failed = 0;
    let missing = 0;

    try {
      const src = await resolvePeer(client, Api, data.sourcePeerKey);
      const dst = await resolvePeer(client, Api, data.targetPeerKey);
      logs.push({ level: "info", message: `Range ${lo}..${hi} (${hi - lo + 1} ids)` });

      if (data.markRead) {
        try {
          await markPeerRead(client, src, hi, () => {});
        } catch {}
      }

      // Fetch existing IDs in the range so we can skip gaps and preserve order.
      const allIds: number[] = [];
      for (let i = lo; i <= hi; i++) allIds.push(i);
      const existing: number[] = [];
      for (let i = 0; i < allIds.length; i += 200) {
        const chunk = allIds.slice(i, i + 200);
        try {
          const res: any = await client.getMessages(src, { ids: chunk });
          const arr = Array.isArray(res) ? res : [res];
          for (const m of arr) {
            if (m && !(m.className ?? "").includes("Empty") && m.id) existing.push(Number(m.id));
          }
        } catch (e) {
          logs.push({ level: "warn", message: `Fetch chunk failed: ${(e as Error).message}` });
        }
      }
      existing.sort((a, b) => a - b);
      missing = allIds.length - existing.length;
      logs.push({ level: "info", message: `Found ${existing.length} real messages (${missing} gaps).` });
      if (!existing.length) {
        return { ok: 0, fail: 0, missing, logs };
      }

      const { default: bigInt } = await import("big-integer");
      // Telegram accepts up to ~100 message IDs per forward call.
      for (let i = 0; i < existing.length; i += 100) {
        const batch = existing.slice(i, i + 100);
        const randomId = batch.map(() => bigInt(Math.floor(Math.random() * 1e18)));
        try {
          await client.invoke(
            new Api.messages.ForwardMessages({
              fromPeer: src,
              toPeer: dst,
              id: batch,
              randomId,
              dropAuthor: data.dropAuthor,
            }),
          );
          forwarded += batch.length;
          logs.push({ level: "success", message: `Forwarded ${batch[0]}..${batch[batch.length - 1]} (${batch.length})` });
        } catch (e) {
          const em = (e as Error).message || String(e);
          const fw = parseFloodWait(em);
          if (fw) {
            logs.push({ level: "warn", message: `FloodWait ${fw.seconds}s — sleeping and retrying batch…` });
            await new Promise((r) => setTimeout(r, (fw.seconds + 1) * 1000));
            i -= 100; // retry this batch
            continue;
          }
          failed += batch.length;
          logs.push({ level: "error", message: `Batch ${batch[0]}..${batch[batch.length - 1]} failed: ${em}` });
        }
        if (data.delayMs > 0 && i + 100 < existing.length) {
          await new Promise((r) => setTimeout(r, data.delayMs));
        }
      }

      return { ok: forwarded, fail: failed, missing, logs };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });