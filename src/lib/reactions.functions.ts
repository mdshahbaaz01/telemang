import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const weightedEmoji = z.object({
  emoji: z.string().min(1).max(16),
  weight: z.number().int().min(1).max(100),
});

const runReactionsSchema = z.object({
  source: z.object({ chat: z.string().min(1).max(200), msgId: z.number().int().positive() }),
  accountIds: z.array(z.string().uuid()).min(1).max(500),
  emojis: z.array(weightedEmoji).min(1).max(20),
  spreadSeconds: z.number().int().min(0).max(3600).default(0),
  minDelay: z.number().int().min(0).max(3600).optional(),
  maxDelay: z.number().int().min(0).max(3600).optional(),
  randomizeOrder: z.boolean().default(true),
  big: z.boolean().default(false),
});

function pickWeighted(emojis: { emoji: string; weight: number }[]) {
  const total = emojis.reduce((n, e) => n + e.weight, 0);
  let r = Math.random() * total;
  for (const e of emojis) {
    r -= e.weight;
    if (r <= 0) return e.emoji;
  }
  return emojis[emojis.length - 1].emoji;
}

function shuffle<T>(a: T[]): T[] {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export type ReactionsExecInput = z.infer<typeof runReactionsSchema>;

export async function executeReactions(
  supabase: SupabaseClient<Database>,
  input: ReactionsExecInput,
) {
  const { openClientForAccount } = await import("./cleanup.server");
  const { Api } = await import("telegram");
  const logs: Array<{ accountId: string | null; target: string | null; level: string; message: string }> = [];
  let ok = 0;
  let fail = 0;
  const accountOrder = input.randomizeOrder ? shuffle(input.accountIds) : input.accountIds;
  const targetLabel = `${input.source.chat}/${input.source.msgId}`;

  const resolveSourcePeer = async (client: any) => {
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
    accountOrder.map(async (accountId, idx) => {
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
        const peer = await resolveSourcePeer(client);
        const emoji = pickWeighted(input.emojis);
        try {
          await client.invoke(
            new Api.messages.GetMessagesViews({
              peer,
              id: [input.source.msgId],
              increment: true,
            }),
          );
        } catch {}
        await client.invoke(
          new Api.messages.SendReaction({
            peer,
            msgId: input.source.msgId,
            reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
            big: input.big,
          }),
        );
        ok++;
        logs.push({ accountId, target: targetLabel, level: "success", message: `Reacted ${emoji}` });
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

export const runReactionsLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runReactionsSchema.parse(d))
  .handler(async ({ data, context }) => {
    return executeReactions(context.supabase, data);
  });