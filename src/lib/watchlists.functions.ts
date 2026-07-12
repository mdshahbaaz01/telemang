import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listWatchlists = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("watchlists")
      .select("id, name, chat, emoji, account_ids, enabled, last_msg_id, last_run_at, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      chat: r.chat as string,
      emoji: r.emoji as string,
      accountIds: (r.account_ids as string[]) ?? [],
      enabled: !!r.enabled,
      lastMsgId: (r.last_msg_id as number) ?? 0,
      lastRunAt: (r.last_run_at as string | null) ?? null,
    }));
  });

export const saveWatchlist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      name: z.string().min(1).max(120),
      chat: z.string().min(1).max(200),
      emoji: z.string().min(1).max(20).default("👍"),
      accountIds: z.array(z.string().uuid()).max(200).default([]),
      enabled: z.boolean().default(true),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.id) {
      const { error } = await context.supabase
        .from("watchlists")
        .update({
          name: data.name,
          chat: data.chat,
          emoji: data.emoji,
          account_ids: data.accountIds,
          enabled: data.enabled,
        })
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("watchlists")
      .insert({
        user_id: context.userId,
        name: data.name,
        chat: data.chat,
        emoji: data.emoji,
        account_ids: data.accountIds,
        enabled: data.enabled,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "insert failed");
    return { id: row.id as string };
  });

export const deleteWatchlist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("watchlists")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Scan a watchlist for a new post and react to it from all selected accounts.
// Uses the first account to peek at the latest message id, then reacts from all.
export const scanWatchlist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("watchlists")
      .select("id, chat, emoji, account_ids, last_msg_id, enabled")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Watchlist not found");
    if (!row.enabled) return { skipped: "disabled", newMsgId: row.last_msg_id, reacted: 0 };
    const accountIds = (row.account_ids as string[]) ?? [];
    if (accountIds.length === 0) throw new Error("No accounts assigned");

    const { getTelegramClient, releaseTelegramClient } = await import("@/lib/telegram-client.server");
    const { resolveTargetEntity } = await import("@/lib/telegram-target-resolver.server");
    const { Api } = await import("telegram");

    // 1) Peek latest message id from first account
    const first = accountIds[0];
    const peekClient = await getTelegramClient(first);
    let latestId = 0;
    try {
      const entity = await resolveTargetEntity(peekClient, Api, row.chat as string);
      const history: any = await peekClient.invoke(new Api.messages.GetHistory({
        peer: entity, limit: 1, offsetId: 0, offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: 0 as any,
      }));
      const msg = history?.messages?.[0];
      latestId = msg?.id ?? 0;
    } finally {
      await releaseTelegramClient(first);
    }

    if (!latestId || latestId <= (row.last_msg_id ?? 0)) {
      await context.supabase
        .from("watchlists")
        .update({ last_run_at: new Date().toISOString() })
        .eq("id", row.id);
      return { skipped: "no-new-post", newMsgId: latestId, reacted: 0 };
    }

    // 2) React from all selected accounts
    let reacted = 0;
    const errors: string[] = [];
    for (const accId of accountIds) {
      const client = await getTelegramClient(accId);
      try {
        const entity = await resolveTargetEntity(client, Api, row.chat as string);
        // View bump then react
        try {
          await client.invoke(new Api.messages.GetMessagesViews({ peer: entity, id: [latestId], increment: true }));
        } catch {}
        await client.invoke(new Api.messages.SendReaction({
          peer: entity,
          msgId: latestId,
          reaction: [new Api.ReactionEmoji({ emoticon: row.emoji as string })],
        }));
        reacted++;
      } catch (e) {
        errors.push(`${accId}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await releaseTelegramClient(accId);
      }
    }

    await context.supabase
      .from("watchlists")
      .update({ last_msg_id: latestId, last_run_at: new Date().toISOString() })
      .eq("id", row.id);

    return { newMsgId: latestId, reacted, errors };
  });
