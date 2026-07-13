import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

const peerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), accessHash: z.string() }),
  z.object({ kind: z.literal("channel"), id: z.string(), accessHash: z.string() }),
  z.object({ kind: z.literal("chat"), id: z.string() }),
]);

const targetSchema = z.object({
  key: z.string(),
  id: z.string(),
  type: z.enum(["user", "bot", "chat", "channel", "megagroup"]),
  title: z.string(),
  peer: peerSchema,
});

const bodySchema = z.object({
  action: z.enum([
    "leave",
    "block",
    "deleteHistory",
    "deletePersonal",
    "leaveByLinks",
    "mute",
    "unmute",
    "archive",
    "unarchive",
    "pin",
    "unpin",
  ]),
  jobs: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        targets: z.array(targetSchema).max(1000).default([]),
        links: z.array(z.string().min(1)).max(500).optional(),
      }),
    )
    .min(1)
    .max(50),
  minDelayMs: z.number().int().min(0).max(120000).optional(),
  maxDelayMs: z.number().int().min(0).max(120000).optional(),
});

function sseEncode(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

export const Route = createFileRoute("/api/public/cleanup-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL!;
        const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
        const authHeader = request.headers.get("authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const token = authHeader.slice(7);
        const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        });
        const { data: claims, error: claimsErr } = await supabase.auth.getClaims(token);
        if (claimsErr || !claims?.claims?.sub) {
          return new Response("Unauthorized", { status: 401 });
        }
        const userId = claims.claims.sub as string;

        // Admin check
        const { data: roles } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId);
        const isAdmin = (roles ?? []).some((r) => r.role === "admin");
        if (!isAdmin) return new Response("Forbidden", { status: 403 });

        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(await request.json());
        } catch (e) {
          return new Response(`Bad request: ${(e as Error).message}`, { status: 400 });
        }

        // Ownership check: all accountIds must belong to userId
        const accountIds = [...new Set(body.jobs.map((j) => j.accountId))];
        const { data: owned, error: ownErr } = await supabase
          .from("telegram_accounts")
          .select("id, user_id, status")
          .in("id", accountIds);
        if (ownErr) return new Response(ownErr.message, { status: 500 });
        const ownedIds = new Set(
          (owned ?? []).filter((a) => a.user_id === userId).map((a) => a.id),
        );
        if (ownedIds.size !== accountIds.length) {
          return new Response("Forbidden: account ownership", { status: 403 });
        }

        const abortSignal = request.signal;

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(sseEncode(event, data));
              } catch {}
            };
            let closed = false;
            const close = () => {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {}
            };
            abortSignal.addEventListener("abort", () => {
              send("aborted", { message: "Stopped by client" });
              close();
            });

            const { openClientForAccount } = await import("@/lib/cleanup.server");
            const { Api } = await import("telegram");
            const { default: bigInt } = await import("big-integer");

            const runOne = async (
              accountId: string,
              targets: typeof body.jobs[number]["targets"],
              links: string[] | undefined,
            ) => {
              send("log", { accountId, kind: "info", message: "Connecting…" });
              let client;
              try {
                client = await openClientForAccount(supabase, accountId);
              } catch (e) {
                send("log", {
                  accountId,
                  kind: "error",
                  message: `Connect failed: ${(e as Error).message}`,
                });
                send("done", { accountId, ok: 0, fail: (targets.length || (links?.length ?? 0)) });
                return;
              }
              let ok = 0;
              let fail = 0;
              try {
                if (body.action === "leaveByLinks") {
                  for (const raw of links ?? []) {
                    if (abortSignal.aborted) break;
                    const label = raw;
                    try {
                      const link = raw.trim().replace(/^https?:\/\//i, "").replace(/^t\.me\//i, "").replace(/^telegram\.me\//i, "");
                      // Private invite: +HASH or joinchat/HASH
                      const inviteMatch = link.match(/^(?:joinchat\/)?\+?([A-Za-z0-9_-]{16,})$/);
                      const isInvite = link.startsWith("+") || link.startsWith("joinchat/");
                      if (isInvite && inviteMatch) {
                        const hash = inviteMatch[1];
                        // Resolve invite → channel id, then leave (import not needed).
                        try {
                          const info: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                          const chat = info?.chat;
                          if (chat?.id && chat?.accessHash) {
                            const peer = new Api.InputPeerChannel({
                              channelId: bigInt(String(chat.id)),
                              accessHash: bigInt(String(chat.accessHash)),
                            });
                            await client.invoke(new Api.channels.LeaveChannel({ channel: peer }));
                            ok++;
                            send("log", { accountId, kind: "ok", target: label, message: "left (invite)" });
                            continue;
                          }
                          // Already a member — CheckChatInvite returns ChatInviteAlready with `chat`; handled above.
                          throw new Error("Invite not resolvable (not a channel/supergroup)");
                        } catch (e) {
                          const em = (e as Error).message || String(e);
                          if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID/i.test(em)) {
                            throw new Error(em + " — link expired or revoked");
                          }
                          throw e;
                        }
                      }
                      // Private numeric link: t.me/c/<id>/...
                      const cMatch = link.match(/^c\/(\d+)/i);
                      if (cMatch) {
                        const entity: any = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(cMatch[1]) }));
                        await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
                        ok++;
                        send("log", { accountId, kind: "ok", target: label, message: "left" });
                        continue;
                      }
                      // Public @username or t.me/username[/msg]
                      const uname = link.replace(/^@/, "").split("/")[0];
                      if (!uname) throw new Error("Empty username");
                      const entity: any = await client.getEntity(uname);
                      if (entity?.className === "Channel") {
                        await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
                      } else if (entity?.className === "Chat") {
                        await client.invoke(
                          new Api.messages.DeleteChatUser({
                            chatId: bigInt(String(entity.id)),
                            userId: new Api.InputUserSelf(),
                            revokeHistory: false,
                          }),
                        );
                      } else {
                        throw new Error(`Not a channel/group (${entity?.className ?? "unknown"})`);
                      }
                      ok++;
                      send("log", { accountId, kind: "ok", target: label, message: "left" });
                    } catch (err) {
                      fail++;
                      send("log", { accountId, kind: "error", target: label, message: (err as Error).message || String(err) });
                    }
                    await new Promise((r) => setTimeout(r, 350));
                  }
                  return;
                }
                for (const t of targets) {
                  if (abortSignal.aborted) break;
                  const label = t.title;
                  try {
                    let peer: any;
                    if (t.peer.kind === "user") {
                      peer = new Api.InputPeerUser({
                        userId: bigInt(t.peer.id),
                        accessHash: bigInt(t.peer.accessHash),
                      });
                    } else if (t.peer.kind === "channel") {
                      peer = new Api.InputPeerChannel({
                        channelId: bigInt(t.peer.id),
                        accessHash: bigInt(t.peer.accessHash),
                      });
                    } else {
                      peer = new Api.InputPeerChat({ chatId: bigInt(t.peer.id) });
                    }

                    if (body.action === "leave") {
                      if (t.peer.kind === "channel") {
                        await client.invoke(new Api.channels.LeaveChannel({ channel: peer }));
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
                    } else if (body.action === "block") {
                      if (t.peer.kind !== "user") throw new Error("Block only applies to users/bots");
                      // Try to block, but skip if Telegram rate-limits it — deleting the chat
                      // is enough to remove a bot/user from the chat list.
                      try {
                        await client.invoke(new Api.contacts.Block({ id: peer }));
                      } catch (blockErr) {
                        const msg = (blockErr as Error).message || String(blockErr);
                        if (/FLOOD|wait of \d+ seconds/i.test(msg)) {
                          send("log", { accountId, kind: "info", target: label, message: "block skipped (rate-limited) — deleting chat only" });
                        } else {
                          throw blockErr;
                        }
                      }
                      await client.invoke(
                        new Api.messages.DeleteHistory({
                          peer,
                          maxId: 0,
                          justClear: false,
                          revoke: true,
                        }),
                      );
                    } else if (body.action === "deleteHistory") {
                      if (t.peer.kind === "channel") {
                        await client.invoke(
                          new Api.channels.DeleteHistory({
                            channel: peer,
                            maxId: 0,
                            forEveryone: false,
                          }),
                        );
                      } else {
                        await client.invoke(
                          new Api.messages.DeleteHistory({
                            peer,
                            maxId: 0,
                            justClear: false,
                            revoke: false,
                          }),
                        );
                      }
                    } else if (body.action === "deletePersonal") {
                      if (t.peer.kind !== "user") throw new Error("Personal delete only applies to users/bots");
                      await client.invoke(
                        new Api.messages.DeleteHistory({
                          peer,
                          maxId: 0,
                          justClear: false,
                          revoke: true,
                        }),
                      );
                    } else if (body.action === "mute" || body.action === "unmute") {
                      const muteUntil = body.action === "mute" ? 2147483647 : 0;
                      await client.invoke(
                        new Api.account.UpdateNotifySettings({
                          peer: new Api.InputNotifyPeer({ peer }),
                          settings: new Api.InputPeerNotifySettings({
                            showPreviews: true,
                            silent: body.action === "mute",
                            muteUntil,
                          }),
                        }),
                      );
                    } else if (body.action === "archive" || body.action === "unarchive") {
                      await client.invoke(
                        new Api.folders.EditPeerFolders({
                          folderPeers: [
                            new Api.InputFolderPeer({ peer, folderId: body.action === "archive" ? 1 : 0 }),
                          ],
                        }),
                      );
                    } else if (body.action === "pin" || body.action === "unpin") {
                      await client.invoke(
                        new Api.messages.ToggleDialogPin({
                          peer: new Api.InputDialogPeer({ peer }),
                          pinned: body.action === "pin",
                        }),
                      );
                    }
                    ok++;
                    send("log", { accountId, kind: "ok", target: label, message: "done" });
                  } catch (err) {
                    fail++;
                    send("log", {
                      accountId,
                      kind: "error",
                      target: label,
                      message: (err as Error).message || String(err),
                    });
                  }
                  await new Promise((r) => setTimeout(r, 350));
                }
              } finally {
                await client.disconnect().catch(() => {});
                send("done", { accountId, ok, fail });
              }
            };

            try {
              await Promise.all(body.jobs.map((j) => runOne(j.accountId, j.targets, j.links)));
              send("end", { aborted: abortSignal.aborted });
            } catch (e) {
              send("log", { kind: "error", message: (e as Error).message });
            } finally {
              close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});