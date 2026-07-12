import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const runViewsSchema = z.object({
  source: z.object({ chat: z.string().min(1).max(200), msgIds: z.array(z.number().int().positive()).min(1).max(20) }),
  accountIds: z.array(z.string().uuid()).min(1).max(1000),
  spreadSeconds: z.number().int().min(0).max(3600).default(0),
  minDelay: z.number().int().min(0).max(3600).optional(),
  maxDelay: z.number().int().min(0).max(3600).optional(),
});

export type ViewsExecInput = z.infer<typeof runViewsSchema>;

export async function executeViewBoost(
  supabase: SupabaseClient<Database>,
  input: ViewsExecInput,
) {
  const { openClientForAccount } = await import("./cleanup.server");
  const { Api } = await import("telegram");
  const logs: Array<{ accountId: string | null; target: string | null; level: string; message: string }> = [];
  let ok = 0;
  let fail = 0;
  const targetLabel = `${input.source.chat}/${input.source.msgIds.join(",")}`;

  const resolvePeer = async (client: any) => {
    const chat = input.source.chat.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
    if (chat.startsWith("c/")) {
      const raw = chat.slice(2);
      const { default: bigInt } = await import("big-integer");
      try {
        return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
      } catch {
        return await client.getEntity(`https://t.me/${chat}`);
      }
    }
    return await client.getEntity(chat);
  };

  await Promise.all(
    input.accountIds.map(async (accountId) => {
      const lo = Math.max(0, input.minDelay ?? 0);
      const hi = Math.max(lo, input.maxDelay ?? input.spreadSeconds ?? 0);
      if (hi > 0) {
        const wait = (lo + Math.random() * (hi - lo)) * 1000;
        await new Promise((r) => setTimeout(r, wait));
      }
      let client;
      try {
        client = await openClientForAccount(supabase, accountId);
      } catch (e) {
        fail++;
        logs.push({ accountId, target: null, level: "error", message: `Connect failed: ${(e as Error).message}` });
        return;
      }
      try {
        const peer = await resolvePeer(client);
        await client.invoke(
          new Api.messages.GetMessagesViews({ peer, id: input.source.msgIds, increment: true }),
        );
        ok++;
        logs.push({ accountId, target: targetLabel, level: "success", message: `View +1 on ${targetLabel}` });
      } catch (e) {
        fail++;
        logs.push({ accountId, target: targetLabel, level: "error", message: (e as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }),
  );

  return { ok, fail, logs };
}

export const runViewBoostLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runViewsSchema.parse(d))
  .handler(async ({ data, context }) => {
    return executeViewBoost(context.supabase, data);
  });