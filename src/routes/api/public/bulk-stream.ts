import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";
import { formatMessage } from "@/lib/message-format";

// ---------- helpers ----------
function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function jitter(min: number, max: number) {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo * 1000 + Math.random() * (hi - lo) * 1000;
}
function errText(e: unknown) {
  return e instanceof Error ? (e.message || e.name) : String(e);
}
function floodSecs(msg: string) {
  const m = msg.match(/FLOOD_WAIT_?(\d+)/i);
  return m ? Number(m[1]) : null;
}

// ---------- schemas ----------
const attachmentSchema = z.object({
  path: z.string().min(1).max(500),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200).optional(),
});

const createChatSchema = z.object({
  kind: z.literal("createChat"),
  chatType: z.enum(["channel", "supergroup"]).default("channel"),
  titlePattern: z.string().min(1).max(120), // supports {n}
  about: z.string().max(500).default(""),
  usernamePattern: z.string().max(32).default(""), // optional; supports {n}
  photo: attachmentSchema.optional(),
  pinnedText: z.string().max(4096).default(""),
});

const inviteToChatSchema = z.object({
  kind: z.literal("inviteToChat"),
  destination: z.string().min(1).max(200), // link / @username / c/<id>
  users: z.array(z.string().min(1).max(200)).min(1).max(2000),
  perAccountCap: z.number().int().min(1).max(200).default(30),
});

const dmBlastSchema = z.object({
  kind: z.literal("dmBlast"),
  sourceGroup: z.string().min(1).max(200),
  message: z.string().min(1).max(4096),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
  skipBots: z.boolean().default(true),
  skipDeleted: z.boolean().default(true),
  onlyRecent: z.boolean().default(false),
  perAccountCap: z.number().int().min(1).max(200).default(20),
  scrapeLimit: z.number().int().min(50).max(10000).default(500),
});

const editSentSchema = z.object({
  kind: z.literal("editSent"),
  runId: z.string().uuid().optional(),
  links: z.array(z.string().min(1).max(500)).max(500).default([]),
  newMessage: z.string().min(1).max(4096),
  format: z.enum(["plain", "mono", "quote", "html"]).default("plain"),
});

const copyCleanSchema = z.object({
  kind: z.literal("copyClean"),
  source: z.string().min(1).max(500), // full message link
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
  signature: z.string().max(200).default(""),
});

const voiceNoteSchema = z.object({
  kind: z.literal("voiceNote"),
  file: attachmentSchema,
  mode: z.enum(["voice", "video"]).default("voice"),
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
});

const pollCreateSchema = z.object({
  kind: z.literal("pollCreate"),
  question: z.string().min(1).max(255),
  options: z.array(z.string().min(1).max(100)).min(2).max(10),
  targets: z.array(z.string().min(1).max(200)).min(1).max(500),
  multiple: z.boolean().default(false),
  anonymous: z.boolean().default(true),
  quiz: z.boolean().default(false),
  correctIndex: z.number().int().min(0).max(9).optional(),
  explanation: z.string().max(200).optional(),
});

const readAllSchema = z.object({
  kind: z.literal("readAll"),
  scope: z.enum(["all", "targets"]).default("all"),
  targets: z.array(z.string().min(1).max(200)).max(500).default([]),
  mode: z.enum(["read", "unread"]).default("read"),
});

const pollVoteSchema = z.object({
  kind: z.literal("pollVote"),
  messageLink: z.string().min(1).max(500),
  optionIndexes: z.array(z.number().int().min(0).max(9)).min(1).max(10),
  retract: z.boolean().default(false),
});

const bodySchema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(200),
  minDelay: z.number().int().min(0).max(120).default(1),
  maxDelay: z.number().int().min(0).max(120).default(3),
  concurrency: z.number().int().min(1).max(20).default(3),
  op: z.discriminatedUnion("kind", [
    createChatSchema, inviteToChatSchema, dmBlastSchema, editSentSchema,
    copyCleanSchema, voiceNoteSchema, pollCreateSchema, pollVoteSchema, readAllSchema,
  ]),
});

// ---------- link parsing ----------
function parseMessageLink(link: string): { chat: string; msgId: number } | null {
  const m = link.trim().match(/t\.me\/(c\/(\d+)|([A-Za-z0-9_]+))\/(\d+)/);
  if (!m) return null;
  const msgId = Number(m[4]);
  if (m[2]) return { chat: `c/${m[2]}`, msgId };
  return { chat: m[3], msgId };
}

// ---------- route ----------
export const Route = createFileRoute("/api/public/bulk-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const SUPABASE_URL = process.env.SUPABASE_URL!;
          const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
          const authHeader = request.headers.get("authorization") ?? "";
          if (!authHeader.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
          const token = authHeader.slice(7);
          const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
          });
          let userId: string;
          try {
            const { data: claims, error } = await supabase.auth.getClaims(token);
            if (error || !claims?.claims?.sub) return new Response(`Unauthorized: ${error?.message ?? "invalid token"}`, { status: 401 });
            userId = claims.claims.sub as string;
          } catch (e) {
            return new Response(`Auth error: ${(e as Error).message}`, { status: 401 });
          }
          const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
          if (!(roles ?? []).some((r) => r.role === "admin")) return new Response("Forbidden", { status: 403 });

          let body: z.infer<typeof bodySchema>;
          try { body = bodySchema.parse(await request.json()); }
          catch (e) { return new Response(`Bad request: ${(e as Error).message}`, { status: 400 }); }

          const { data: runRow, error: runErr } = await supabase
            .from("action_runs")
            .insert({ user_id: userId, kind: body.op.kind, status: "running", params: JSON.parse(JSON.stringify(body)) })
            .select("id").single();
          if (runErr || !runRow) return new Response(`run insert failed: ${runErr?.message ?? "unknown"}`, { status: 500 });
          const runId = runRow.id as string;

          const abortSignal = request.signal;

          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              let closed = false;
              const send = (event: string, data: unknown) => { try { controller.enqueue(sseEncode(event, data)); } catch {} };
              const close = () => { if (!closed) { closed = true; try { controller.close(); } catch {} } };
              const logDb = async (accountId: string | null, target: string | null, level: "info"|"success"|"warn"|"error", message: string) => {
                try {
                  await supabase.from("action_logs").insert({ run_id: runId, account_id: accountId, target, level, message });
                } catch { /* swallow */ }
              };

              let stopRequested = false;
              abortSignal.addEventListener("abort", () => { stopRequested = true; send("aborted", {}); });
              const stopPoll = setInterval(async () => {
                const { data: r } = await supabase.from("action_runs").select("status").eq("id", runId).maybeSingle();
                if (r?.status === "stopped") stopRequested = true;
              }, 2000);

              send("start", { runId, kind: body.op.kind });

              const { openClientForAccount } = await import("@/lib/cleanup.server");
              const { resolveTargetEntity } = await import("@/lib/telegram-target-resolver.server");
              const { Api } = await import("telegram");
              const { CustomFile } = await import("telegram/client/uploads");
              const bigIntMod = await import("big-integer");
              const bigInt = bigIntMod.default;

              const { runWithLimit } = await import("@/lib/p-limit");

              // Attachment cache: same file bytes reused per account upload
              const attCache = new Map<string, { buf: Buffer; filename: string; mimeType?: string }>();
              const loadAttachment = async (att: { path: string; filename: string; mimeType?: string }) => {
                const cached = attCache.get(att.path);
                if (cached) return cached;
                const { data, error } = await supabase.storage.from("action-attachments").createSignedUrl(att.path, 300);
                if (error || !data?.signedUrl) throw new Error(`Attachment fetch failed: ${error?.message ?? "no url"}`);
                const res = await fetch(data.signedUrl);
                if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
                const buf = Buffer.from(await res.arrayBuffer());
                const val = { buf, filename: att.filename, mimeType: att.mimeType };
                attCache.set(att.path, val);
                return val;
              };
              const buildCustomFile = (att: { buf: Buffer; filename: string; mimeType?: string }) =>
                new CustomFile(att.filename, att.buf.length, att.filename, att.buf);

              const pauseFlood = async (accountId: string, msg: string) => {
                const secs = floodSecs(msg);
                if (!secs) return null;
                const pausedUntil = new Date(Date.now() + secs * 1000).toISOString();
                await supabase.from("telegram_accounts").update({ paused_until: pausedUntil, last_error: `FloodWait ${secs}s` }).eq("id", accountId);
                return secs;
              };

              const op = body.op;

              // === Executors ===
              const execCreateChat = async (accountId: string, idx: number) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  client = await openClientForAccount(supabase, accountId);
                  const title = op.kind === "createChat" ? op.titlePattern.replace(/\{n\}/g, String(idx + 1)) : "";
                  if (op.kind !== "createChat") return { ok, fail };
                  const res: any = await client.invoke(new Api.channels.CreateChannel({
                    title, about: op.about || "",
                    megagroup: op.chatType === "supergroup" ? true : undefined,
                    broadcast: op.chatType === "channel" ? true : undefined,
                  } as any));
                  const created = res?.chats?.[0];
                  if (!created) throw new Error("No chat returned");
                  const chan = new Api.InputChannel({ channelId: created.id, accessHash: created.accessHash });
                  if (op.usernamePattern) {
                    const uname = op.usernamePattern.replace(/\{n\}/g, String(idx + 1)).replace(/^@/, "");
                    try { await client.invoke(new Api.channels.UpdateUsername({ channel: chan, username: uname })); }
                    catch (e) { send("log", { accountId, level: "warn", message: `Username '${uname}' failed: ${errText(e)}` }); }
                  }
                  if (op.photo) {
                    try {
                      const att = await loadAttachment(op.photo);
                      const uploaded = await client.uploadFile({ file: buildCustomFile(att), workers: 1 });
                      await client.invoke(new Api.channels.EditPhoto({ channel: chan, photo: new Api.InputChatUploadedPhoto({ file: uploaded }) }));
                    } catch (e) { send("log", { accountId, level: "warn", message: `Photo failed: ${errText(e)}` }); }
                  }
                  if (op.pinnedText) {
                    try {
                      const sent: any = await client.sendMessage(chan, { message: op.pinnedText });
                      const msgId = sent?.id;
                      if (msgId) await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: chan, id: msgId, silent: true }));
                    } catch (e) { send("log", { accountId, level: "warn", message: `Pin failed: ${errText(e)}` }); }
                  }
                  ok = 1;
                  const label = `${title}${op.usernamePattern ? " (@" + op.usernamePattern.replace(/\{n\}/g, String(idx + 1)) + ")" : ""}`;
                  send("log", { accountId, level: "success", target: label, message: `Created ${op.chatType}: ${label}` });
                  await logDb(accountId, label, "success", `Created ${op.chatType}`);
                } catch (e) {
                  fail = 1;
                  const m = errText(e);
                  send("log", { accountId, level: "error", message: m });
                  await logDb(accountId, null, "error", m);
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              const execInviteToChat = async (accountId: string) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  if (op.kind !== "inviteToChat") return { ok, fail };
                  client = await openClientForAccount(supabase, accountId);
                  const dest = await resolveTargetEntity(client, Api, op.destination);
                  const cap = Math.min(op.perAccountCap, op.users.length);
                  const slice = op.users.slice(0, cap);
                  // Resolve users in batches of 50
                  for (let i = 0; i < slice.length; i += 50) {
                    if (stopRequested) break;
                    const chunk = slice.slice(i, i + 50);
                    const inputUsers: any[] = [];
                    for (const u of chunk) {
                      try {
                        const ent = await client.getEntity(u.replace(/^@/, ""));
                        inputUsers.push(await client.getInputEntity(ent));
                      } catch (e) {
                        fail++;
                        send("log", { accountId, level: "warn", target: u, message: `Resolve failed: ${errText(e)}` });
                        await logDb(accountId, u, "warn", errText(e));
                      }
                    }
                    if (!inputUsers.length) continue;
                    try {
                      await client.invoke(new Api.channels.InviteToChannel({ channel: dest, users: inputUsers }));
                      ok += inputUsers.length;
                      send("log", { accountId, level: "success", message: `Invited ${inputUsers.length}` });
                      await logDb(accountId, op.destination, "success", `Invited ${inputUsers.length}`);
                    } catch (e) {
                      const m = errText(e);
                      const secs = await pauseFlood(accountId, m);
                      if (secs) { send("log", { accountId, level: "warn", message: `FloodWait ${secs}s — pausing` }); break; }
                      fail += inputUsers.length;
                      send("log", { accountId, level: "error", message: m });
                      await logDb(accountId, op.destination, "error", m);
                    }
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                  }
                } catch (e) {
                  fail = 1;
                  const m = errText(e);
                  send("log", { accountId, level: "error", message: m });
                  await logDb(accountId, null, "error", m);
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              // Shared: scrape members for dmBlast (done once, on first account)
              let dmScraped: string[] | null = null;
              const scrapeMembers = async (client: any): Promise<string[]> => {
                if (op.kind !== "dmBlast") return [];
                const grp = await resolveTargetEntity(client, Api, op.sourceGroup);
                const users: any[] = [];
                let offset = 0;
                const per = 200;
                while (users.length < op.scrapeLimit) {
                  const res: any = await client.invoke(new Api.channels.GetParticipants({
                    channel: grp,
                    filter: new Api.ChannelParticipantsRecent(),
                    offset, limit: per, hash: bigInt(0) as any,
                  }));
                  const batch = res?.users ?? [];
                  if (!batch.length) break;
                  users.push(...batch);
                  offset += per;
                  if (batch.length < per) break;
                }
                const recentCut = Date.now() / 1000 - 7 * 86400;
                const filtered = users.filter((u: any) => {
                  if (op.skipBots && u.bot) return false;
                  if (op.skipDeleted && u.deleted) return false;
                  if (op.onlyRecent) {
                    const ts = u.status?.wasOnline ?? u.status?.expires ?? 0;
                    if (!ts || Number(ts) < recentCut) return false;
                  }
                  return !!u.id;
                });
                return filtered.map((u: any) => String(u.id));
              };

              const execDmBlast = async (accountId: string, accountIdx: number, allAccts: string[]) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  if (op.kind !== "dmBlast") return { ok, fail };
                  client = await openClientForAccount(supabase, accountId);
                  if (!dmScraped) {
                    send("log", { accountId, level: "info", message: `Scraping members from ${op.sourceGroup}…` });
                    dmScraped = await scrapeMembers(client);
                    send("log", { accountId, level: "info", message: `Scraped ${dmScraped.length} users` });
                  }
                  // Round-robin distribution
                  const myTargets = dmScraped.filter((_, i) => i % allAccts.length === accountIdx).slice(0, op.perAccountCap);
                  const formatted = formatMessage(op.message, op.format);
                  for (const uid of myTargets) {
                    if (stopRequested) break;
                    try {
                      const ent = await client.getEntity(uid);
                      await client.sendMessage(ent, { message: formatted.message, parseMode: formatted.parseMode });
                      ok++;
                      send("log", { accountId, level: "success", target: uid, message: `DM sent` });
                      await logDb(accountId, uid, "success", "DM sent");
                    } catch (e) {
                      const m = errText(e);
                      const secs = await pauseFlood(accountId, m);
                      if (secs) { send("log", { accountId, level: "warn", message: `FloodWait ${secs}s — pausing` }); break; }
                      fail++;
                      send("log", { accountId, level: "error", target: uid, message: m });
                      await logDb(accountId, uid, "error", m);
                    }
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                  }
                } catch (e) {
                  fail = 1;
                  send("log", { accountId, level: "error", message: errText(e) });
                  await logDb(accountId, null, "error", errText(e));
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              // For editSent: gather links (from runId's action_logs targets, or explicit)
              let editLinks: string[] = [];
              if (op.kind === "editSent") {
                editLinks = [...op.links];
                if (op.runId) {
                  const { data: logs } = await supabase.from("action_logs")
                    .select("target, message, account_id")
                    .eq("run_id", op.runId).eq("level", "success");
                  // We can't reconstruct message IDs from targets alone (broadcast logs don't store msgIds)
                  // So editSent by runId only works when explicit t.me links are in the target field.
                  const fromLogs = (logs ?? []).map((l) => l.target).filter((t): t is string => !!t && t.includes("t.me/"));
                  editLinks.push(...fromLogs);
                }
              }

              const execEditSent = async (accountId: string) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  if (op.kind !== "editSent") return { ok, fail };
                  client = await openClientForAccount(supabase, accountId);
                  const formatted = formatMessage(op.newMessage, op.format);
                  for (const link of editLinks) {
                    if (stopRequested) break;
                    const parsed = parseMessageLink(link);
                    if (!parsed) { fail++; continue; }
                    try {
                      const peer = parsed.chat.startsWith("c/")
                        ? await client.getEntity(new Api.PeerChannel({ channelId: bigInt(parsed.chat.slice(2)) }))
                        : await client.getEntity(parsed.chat);
                      await client.editMessage(peer, { message: parsed.msgId, text: formatted.message, parseMode: formatted.parseMode });
                      ok++;
                      send("log", { accountId, level: "success", target: link, message: "Edited" });
                      await logDb(accountId, link, "success", "Edited");
                    } catch (e) {
                      const m = errText(e);
                      if (/MESSAGE_NOT_MODIFIED/i.test(m)) {
                        send("log", { accountId, level: "info", target: link, message: "Unchanged" }); continue;
                      }
                      fail++;
                      send("log", { accountId, level: "error", target: link, message: m });
                      await logDb(accountId, link, "error", m);
                    }
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                  }
                } catch (e) {
                  fail = 1;
                  send("log", { accountId, level: "error", message: errText(e) });
                  await logDb(accountId, null, "error", errText(e));
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              const execCopyClean = async (accountId: string) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  if (op.kind !== "copyClean") return { ok, fail };
                  client = await openClientForAccount(supabase, accountId);
                  const parsed = parseMessageLink(op.source);
                  if (!parsed) throw new Error("Invalid source link");
                  const srcPeer = parsed.chat.startsWith("c/")
                    ? await client.getEntity(new Api.PeerChannel({ channelId: bigInt(parsed.chat.slice(2)) }))
                    : await client.getEntity(parsed.chat);
                  const [srcMsg]: any[] = await client.getMessages(srcPeer, { ids: [parsed.msgId] });
                  if (!srcMsg) throw new Error("Source message not found");
                  const text = (srcMsg.message ?? "") + (op.signature ? "\n\n" + op.signature : "");
                  for (const t of op.targets) {
                    if (stopRequested) break;
                    try {
                      const dest = await resolveTargetEntity(client, Api, t);
                      if (srcMsg.media) {
                        await client.sendFile(dest, { file: srcMsg.media, caption: text || undefined });
                      } else {
                        await client.sendMessage(dest, { message: text });
                      }
                      ok++;
                      send("log", { accountId, level: "success", target: t, message: "Copied (clean)" });
                      await logDb(accountId, t, "success", "Copied clean");
                    } catch (e) {
                      const m = errText(e);
                      const secs = await pauseFlood(accountId, m);
                      if (secs) { send("log", { accountId, level: "warn", message: `FloodWait ${secs}s` }); break; }
                      fail++;
                      send("log", { accountId, level: "error", target: t, message: m });
                      await logDb(accountId, t, "error", m);
                    }
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                  }
                } catch (e) {
                  fail = 1;
                  send("log", { accountId, level: "error", message: errText(e) });
                  await logDb(accountId, null, "error", errText(e));
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              const execVoiceNote = async (accountId: string) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  if (op.kind !== "voiceNote") return { ok, fail };
                  client = await openClientForAccount(supabase, accountId);
                  const att = await loadAttachment(op.file);
                  for (const t of op.targets) {
                    if (stopRequested) break;
                    try {
                      const dest = await resolveTargetEntity(client, Api, t);
                      const opts: any = { file: buildCustomFile(att) };
                      if (op.mode === "voice") opts.voiceNote = true;
                      else opts.videoNote = true;
                      await client.sendFile(dest, opts);
                      ok++;
                      send("log", { accountId, level: "success", target: t, message: `${op.mode} note sent` });
                      await logDb(accountId, t, "success", `${op.mode} note sent`);
                    } catch (e) {
                      const m = errText(e);
                      const secs = await pauseFlood(accountId, m);
                      if (secs) { send("log", { accountId, level: "warn", message: `FloodWait ${secs}s` }); break; }
                      fail++;
                      send("log", { accountId, level: "error", target: t, message: m });
                      await logDb(accountId, t, "error", m);
                    }
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                  }
                } catch (e) {
                  fail = 1;
                  send("log", { accountId, level: "error", message: errText(e) });
                  await logDb(accountId, null, "error", errText(e));
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              const execPollCreate = async (accountId: string) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  if (op.kind !== "pollCreate") return { ok, fail };
                  client = await openClientForAccount(supabase, accountId);
                  for (const t of op.targets) {
                    if (stopRequested) break;
                    try {
                      const dest = await resolveTargetEntity(client, Api, t);
                      const answers = op.options.map((txt, i) => new Api.PollAnswer({
                        text: new Api.TextWithEntities({ text: txt, entities: [] }) as any,
                        option: Buffer.from([i]),
                      } as any));
                      const poll = new Api.Poll({
                        id: bigInt(Math.floor(Math.random() * 1e15)) as any,
                        question: new Api.TextWithEntities({ text: op.question, entities: [] }) as any,
                        answers,
                        publicVoters: !op.anonymous || undefined,
                        multipleChoice: op.multiple || undefined,
                        quiz: op.quiz || undefined,
                      } as any);
                      const media = new Api.InputMediaPoll({
                        poll,
                        correctAnswers: op.quiz && op.correctIndex !== undefined ? [Buffer.from([op.correctIndex])] : undefined,
                        solution: op.quiz ? op.explanation || undefined : undefined,
                        solutionEntities: op.quiz && op.explanation ? [] : undefined,
                      } as any);
                      await client.invoke(new Api.messages.SendMedia({
                        peer: dest, media, message: "",
                        randomId: bigInt(Math.floor(Math.random() * 1e18)) as any,
                      }));
                      ok++;
                      send("log", { accountId, level: "success", target: t, message: `Poll sent` });
                      await logDb(accountId, t, "success", "Poll sent");
                    } catch (e) {
                      const m = errText(e);
                      const secs = await pauseFlood(accountId, m);
                      if (secs) { send("log", { accountId, level: "warn", message: `FloodWait ${secs}s` }); break; }
                      fail++;
                      send("log", { accountId, level: "error", target: t, message: m });
                      await logDb(accountId, t, "error", m);
                    }
                    await new Promise((r) => setTimeout(r, jitter(body.minDelay, body.maxDelay)));
                  }
                } catch (e) {
                  fail = 1;
                  send("log", { accountId, level: "error", message: errText(e) });
                  await logDb(accountId, null, "error", errText(e));
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              const execReadAll = async (accountId: string) => {
                let client: any; let ok = 0, fail = 0;
                try {
                  if (op.kind !== "readAll") return { ok, fail };
                  client = await openClientForAccount(supabase, accountId);
                  let peers: any[] = [];
                  if (op.scope === "all") {
                    const dialogs: any[] = await client.getDialogs({ limit: 500 });
                    peers = dialogs
                      .filter((d) => op.mode === "read" ? (d.unreadCount ?? 0) > 0 : true)
                      .map((d) => d.inputEntity ?? d.entity);
                  } else {
                    for (const t of op.targets) {
                      try { peers.push(await resolveTargetEntity(client, Api, t)); } catch { fail++; }
                    }
                  }
                  for (const peer of peers) {
                    if (stopRequested) break;
                    try {
                      if (op.mode === "read") {
                        // messages.ReadHistory for users/chats; channels.ReadHistory for channels
                        try { await client.invoke(new Api.messages.ReadHistory({ peer, maxId: 0 } as any)); }
                        catch { await client.invoke(new Api.channels.ReadHistory({ channel: peer, maxId: 0 } as any)); }
                      } else {
                        await client.invoke(new Api.messages.MarkDialogUnread({ peer: new Api.InputDialogPeer({ peer }), unread: true } as any));
                      }
                      ok++;
                    } catch (e) {
                      fail++;
                      send("log", { accountId, level: "warn", message: errText(e) });
                    }
                  }
                  send("log", { accountId, level: "success", message: `${op.mode === "read" ? "Marked read" : "Marked unread"}: ${ok}, failed: ${fail}` });
                  await logDb(accountId, null, "success", `${op.mode}: ok ${ok}, fail ${fail}`);
                } catch (e) {
                  fail = 1;
                  send("log", { accountId, level: "error", message: errText(e) });
                  await logDb(accountId, null, "error", errText(e));
                } finally {
                  await client?.disconnect?.().catch(() => {});
                  send("done", { accountId, ok, fail });
                }
                return { ok, fail };
              };

              // === Dispatch ===
              const accts = body.accountIds;
              const runOne = async (accountId: string, idx: number) => {
                if (stopRequested) return { ok: 0, fail: 0 };
                send("log", { accountId, level: "info", message: "Connecting…" });
                try {
                  switch (op.kind) {
                    case "createChat": return await execCreateChat(accountId, idx);
                    case "inviteToChat": return await execInviteToChat(accountId);
                    case "dmBlast": return await execDmBlast(accountId, idx, accts);
                    case "editSent": return await execEditSent(accountId);
                    case "copyClean": return await execCopyClean(accountId);
                    case "voiceNote": return await execVoiceNote(accountId);
                    case "pollCreate": return await execPollCreate(accountId);
                    case "readAll": return await execReadAll(accountId);
                  }
                } catch (e) {
                  send("log", { accountId, level: "error", message: errText(e) });
                  return { ok: 0, fail: 1 };
                }
                return { ok: 0, fail: 0 };
              };

              try {
                const indexed = accts.map((id, i) => ({ id, i }));
                const results = await runWithLimit(indexed, body.concurrency, (item) => runOne(item.id, item.i));
                const totals = results.reduce((acc, r) => ({ ok: acc.ok + (r?.ok ?? 0), fail: acc.fail + (r?.fail ?? 0) }), { ok: 0, fail: 0 });
                await supabase.from("action_runs").update({
                  status: stopRequested ? "stopped" : "done",
                  totals: totals as any,
                }).eq("id", runId);
                send("summary", { runId, ...totals });
              } catch (e) {
                await supabase.from("action_runs").update({ status: "failed" }).eq("id", runId);
                send("error", { message: errText(e) });
              } finally {
                clearInterval(stopPoll);
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
        } catch (e) {
          return new Response(`Server error: ${(e as Error).message}`, { status: 500 });
        }
      },
    },
  },
});