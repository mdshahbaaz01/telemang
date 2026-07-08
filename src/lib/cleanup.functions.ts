import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type DialogRow = {
  id: string;
  type: "user" | "bot" | "chat" | "channel" | "megagroup";
  title: string;
  username: string | null;
};

async function openClientForAccount(supabase: any, accountId: string) {
  const { decryptString } = await import("./crypto.server");
  const { createTgClient } = await import("./telegram-client.server");
  const { data: acct, error } = await supabase
    .from("telegram_accounts")
    .select("id, api_id, api_hash_enc, session_enc, status")
    .eq("id", accountId)
    .single();
  if (error || !acct) throw new Error("Account not found");
  if (acct.status === "disabled") throw new Error("Account disabled");
  if (!acct.session_enc) throw new Error("Account not logged in");
  const apiHash = await decryptString(acct.api_hash_enc);
  const sessionStr = await decryptString(acct.session_enc);
  const client = await createTgClient(acct.api_id, apiHash, sessionStr);
  return client;
}

export const listDialogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ accountId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<DialogRow[]> => {
    const client = await openClientForAccount(context.supabase, data.accountId);
    try {
      const dialogs = await client.getDialogs({ limit: 300 });
      const rows: DialogRow[] = [];
      for (const d of dialogs) {
        const e = d.entity as any;
        if (!e) continue;
        const idStr = String(e.id);
        let type: DialogRow["type"] = "chat";
        if (e.className === "User") type = e.bot ? "bot" : "user";
        else if (e.className === "Channel")
          type = e.megagroup ? "megagroup" : "channel";
        else if (e.className === "Chat") type = "chat";
        const title =
          e.title ||
          [e.firstName, e.lastName].filter(Boolean).join(" ") ||
          e.username ||
          idStr;
        rows.push({
          id: idStr,
          type,
          title,
          username: e.username ?? null,
        });
      }
      return rows;
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

const runSchema = z.object({
  accountId: z.string().uuid(),
  targets: z.array(z.string()).min(1).max(500),
  action: z.enum(["leave", "block", "deleteHistory"]),
});

export const runCleanup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runSchema.parse(d))
  .handler(async ({ data, context }) => {
    const client = await openClientForAccount(context.supabase, data.accountId);
    const { Api } = await import("telegram");
    const results: { target: string; ok: boolean; error?: string }[] = [];
    try {
      for (const t of data.targets) {
        try {
          const entity = await client.getEntity(
            /^-?\d+$/.test(t) ? (BigInt(t) as any) : t,
          );
          const e = entity as any;
          if (data.action === "leave") {
            if (e.className === "Channel") {
              await client.invoke(
                new Api.channels.LeaveChannel({ channel: entity as any }),
              );
            } else if (e.className === "Chat") {
              await client.invoke(
                new Api.messages.DeleteChatUser({
                  chatId: e.id,
                  userId: new Api.InputUserSelf(),
                  revokeHistory: false,
                }),
              );
            } else {
              throw new Error("Not a group/channel");
            }
          } else if (data.action === "block") {
            if (e.className !== "User")
              throw new Error("Block only applies to users/bots");
            await client.invoke(
              new Api.contacts.Block({ id: entity as any }),
            );
          } else if (data.action === "deleteHistory") {
            if (e.className === "Channel") {
              await client.invoke(
                new Api.channels.DeleteHistory({
                  channel: entity as any,
                  maxId: 0,
                  forEveryone: false,
                }),
              );
            } else {
              await client.invoke(
                new Api.messages.DeleteHistory({
                  peer: entity as any,
                  maxId: 0,
                  justClear: false,
                  revoke: false,
                }),
              );
            }
          }
          results.push({ target: t, ok: true });
          // small pause to avoid flood
          await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          results.push({
            target: t,
            ok: false,
            error: (err as Error).message || String(err),
          });
        }
      }
      return { results };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });