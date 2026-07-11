import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runWithLimit } from "./p-limit";

export type SearchHit = {
  accountId: string;
  accountName: string;
  kind: "chat" | "user" | "message";
  chatKey: string; // resolvable key for the viewer
  title: string;
  subtitle?: string;
  messageId?: number;
  snippet?: string;
};

export const globalSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        query: z.string().min(1).max(200),
        accountIds: z.array(z.string().uuid()).min(1).max(50),
        scope: z.enum(["chats", "messages", "users"]).default("chats"),
        concurrency: z.number().int().min(1).max(20).default(5),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ hits: SearchHit[]; errors: Array<{ accountId: string; message: string }> }> => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");

    // Load account names once
    const { data: accs } = await context.supabase
      .from("telegram_accounts")
      .select("id, first_name, username, phone")
      .in("id", data.accountIds);
    const nameFor = new Map<string, string>(
      (accs ?? []).map((a: any) => [a.id, a.first_name || a.username || a.phone || a.id.slice(0, 6)]),
    );

    const hits: SearchHit[] = [];
    const errors: Array<{ accountId: string; message: string }> = [];

    await runWithLimit(data.accountIds, data.concurrency, async (accountId) => {
      let client;
      try {
        client = await openClientForAccount(context.supabase, accountId, { requireOwnerId: context.userId });
      } catch (e) {
        errors.push({ accountId, message: `Connect failed: ${(e as Error).message}` });
        return;
      }
      try {
        const accountName = nameFor.get(accountId) ?? accountId.slice(0, 6);
        if (data.scope === "messages") {
          const res: any = await client.invoke(
            new Api.messages.SearchGlobal({
              q: data.query,
              filter: new Api.InputMessagesFilterEmpty(),
              minDate: 0,
              maxDate: 0,
              offsetRate: 0,
              offsetPeer: new Api.InputPeerEmpty(),
              offsetId: 0,
              limit: 30,
            }),
          );
          const chats = [...(res?.chats ?? []), ...(res?.users ?? [])];
          for (const m of res?.messages ?? []) {
            const peerId = m?.peerId?.channelId ?? m?.peerId?.chatId ?? m?.peerId?.userId;
            const chat = chats.find((c: any) => String(c?.id) === String(peerId));
            const title = chat?.title || chat?.firstName || chat?.username || "Unknown";
            const chatKey = chat?.username
              ? chat.username
              : chat?.className === "Channel" || chat?.className === "Chat"
                ? `c/${String(chat.id)}`
                : String(chat?.id ?? "");
            hits.push({
              accountId,
              accountName,
              kind: "message",
              chatKey,
              title,
              messageId: m?.id,
              snippet: String(m?.message ?? "").slice(0, 140),
            });
          }
        } else {
          const res: any = await client.invoke(
            new Api.contacts.Search({ q: data.query, limit: 30 }),
          );
          const usersRes = [...(res?.users ?? [])];
          const chatsRes = [...(res?.chats ?? [])];
          if (data.scope === "users") {
            for (const u of usersRes) {
              hits.push({
                accountId,
                accountName,
                kind: "user",
                chatKey: u?.username || String(u?.id ?? ""),
                title: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.username || String(u?.id),
                subtitle: u?.username ? `@${u.username}` : undefined,
              });
            }
          } else {
            for (const c of chatsRes) {
              hits.push({
                accountId,
                accountName,
                kind: "chat",
                chatKey: c?.username || `c/${String(c?.id)}`,
                title: c?.title || c?.username || String(c?.id),
                subtitle: c?.username ? `@${c.username}` : c?.megagroup ? "supergroup" : c?.broadcast ? "channel" : "group",
              });
            }
          }
        }
      } catch (e) {
        errors.push({ accountId, message: (e as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    });

    return { hits, errors };
  });