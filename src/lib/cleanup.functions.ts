import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { openClientForAccount } from "./cleanup.server";

type CleanupPeer =
  | { kind: "user"; id: string; accessHash: string }
  | { kind: "channel"; id: string; accessHash: string }
  | { kind: "chat"; id: string };

type DialogRow = {
  key: string;
  id: string;
  type: "user" | "bot" | "chat" | "channel" | "megagroup";
  title: string;
  username: string | null;
  peer: CleanupPeer;
};

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  if (!(data ?? []).some((r: any) => r.role === "admin")) {
    throw new Error("Forbidden: admin only");
  }
}

export const listDialogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ accountId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<DialogRow[]> => {
    await assertAdmin(context.supabase, context.userId);
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    try {
      const dialogs = await client.getDialogs({ limit: 3000 });
      const rows: DialogRow[] = [];
      const serializePeer = (inputPeer: any, entity: any): CleanupPeer | null => {
        if (inputPeer?.className === "InputPeerUser") {
          return {
            kind: "user",
            id: String(inputPeer.userId),
            accessHash: String(inputPeer.accessHash),
          };
        }
        if (inputPeer?.className === "InputPeerChannel") {
          return {
            kind: "channel",
            id: String(inputPeer.channelId),
            accessHash: String(inputPeer.accessHash),
          };
        }
        if (inputPeer?.className === "InputPeerChat") {
          return { kind: "chat", id: String(inputPeer.chatId) };
        }
        if (entity?.className === "Chat") return { kind: "chat", id: String(entity.id) };
        return null;
      };
      for (const d of dialogs) {
        const e = d.entity as any;
        if (!e) continue;
        const peer = serializePeer((d as any).inputEntity, e);
        if (!peer) continue;
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
          key: `${peer.kind}:${peer.id}`,
          id: idStr,
          type,
          title,
          username: e.username ?? null,
          peer,
        });
      }
      return rows;
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

const peerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), accessHash: z.string() }),
  z.object({ kind: z.literal("channel"), id: z.string(), accessHash: z.string() }),
  z.object({ kind: z.literal("chat"), id: z.string() }),
]);

const runSchema = z.object({
  accountId: z.string().uuid(),
  targets: z
    .array(
      z.object({
        key: z.string(),
        id: z.string(),
        type: z.enum(["user", "bot", "chat", "channel", "megagroup"]),
        title: z.string(),
        peer: peerSchema,
      }),
    )
    .min(1)
    .max(500),
  action: z.enum(["leave", "block", "deleteHistory"]),
});

export const runCleanup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const client = await openClientForAccount(context.supabase, data.accountId, {
      requireOwnerId: context.userId,
    });
    const { Api } = await import("telegram");
    const { default: bigInt } = await import("big-integer");
    const toInputPeer = (target: (typeof data.targets)[number]) => {
      if (target.peer.kind === "user") {
        return new Api.InputPeerUser({
          userId: bigInt(target.peer.id),
          accessHash: bigInt(target.peer.accessHash),
        });
      }
      if (target.peer.kind === "channel") {
        return new Api.InputPeerChannel({
          channelId: bigInt(target.peer.id),
          accessHash: bigInt(target.peer.accessHash),
        });
      }
      return new Api.InputPeerChat({ chatId: bigInt(target.peer.id) });
    };
    const results: { target: string; ok: boolean; error?: string }[] = [];
    try {
      for (const t of data.targets) {
        const label = `${t.title} (${t.id})`;
        try {
          const entity = toInputPeer(t);
          if (data.action === "leave") {
            if (t.peer.kind === "channel") {
              await client.invoke(
                new Api.channels.LeaveChannel({ channel: entity as any }),
              );
            } else if (t.peer.kind === "chat") {
              await client.invoke(
                new Api.messages.DeleteChatUser({
                  chatId: bigInt(t.peer.id),
                  userId: new Api.InputUserSelf(),
                  revokeHistory: false,
                }),
              );
            } else {
              throw new Error("Not a group/channel");
            }
          } else if (data.action === "block") {
            if (t.peer.kind !== "user")
              throw new Error("Block only applies to users/bots");
            await client.invoke(
              new Api.contacts.Block({ id: entity as any }),
            );
          } else if (data.action === "deleteHistory") {
            if (t.peer.kind === "channel") {
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
          results.push({ target: label, ok: true });
          // small pause to avoid flood
          await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          results.push({
            target: label,
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