type JoinLogLevel = "info" | "warn" | "success" | "error";

export type SmartTelegramJoinResult = {
  status: "joined" | "requested" | "already";
  path:
    | "peek_already"
    | "peek_username"
    | "peek_chat"
    | "peek_search_username"
    | "import_invite"
    | "import_username"
    | "direct_username";
  message: string;
  note: string | null;
  canonicalTarget: string | null;
  errorCode: string | null;
  verified: boolean;
  canonicalChannelId: string | null;
};

type Logger = (level: JoinLogLevel, message: string) => void;

function textOf(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function extractTelegramErrorCode(message: string): string | null {
  const m = message.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return m ? m[1] : null;
}

function classNameOf(value: any): string {
  return String(value?.className ?? value?.constructor?.name ?? "");
}

function cleanTitle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstChatFrom(value: any): any | null {
  if (!value) return null;
  if (value.chat) return value.chat;
  if (Array.isArray(value.chats) && value.chats.length) return value.chats[0];
  if (Array.isArray(value.updates)) {
    for (const upd of value.updates) {
      if (upd?.chat) return upd.chat;
      if (upd?.channel) return upd.channel;
    }
  }
  return null;
}

async function verifyMembership(client: any, Api: any, channel: any): Promise<boolean> {
  if (!channel) return false;
  if (channel.left === false || channel.creator || channel.adminRights) return true;
  try {
    const me = await client.getMe(true);
    const inputChannel = await client.getInputEntity(channel);
    await client.invoke(new Api.channels.GetParticipant({ channel: inputChannel, participant: me }));
    return true;
  } catch (error) {
    const msg = textOf(error);
    if (/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED/i.test(msg)) return false;
    return false;
  }
}

async function waitForMembership(client: any, Api: any, channel: any): Promise<boolean> {
  const waits = [0, 500, 1200, 2200];
  for (const wait of waits) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (await verifyMembership(client, Api, channel)) return true;
  }
  return false;
}

function idOf(entity: any): string | null {
  const raw = entity?.id ?? entity?.channelId ?? entity?.chatId;
  if (raw === null || raw === undefined) return null;
  try {
    return typeof raw === "bigint" ? raw.toString() : String(raw);
  } catch {
    return null;
  }
}

async function verifyCanonicalMatch(
  client: any,
  Api: any,
  expected: any,
  label: string,
  log?: Logger,
): Promise<string> {
  const expectedId = idOf(expected);
  if (!expectedId) throw new Error(`JOIN_CANONICAL_MISMATCH: ${label} missing id`);
  const inputChannel = await client.getInputEntity(expected);
  const resp: any = await client.invoke(new Api.channels.GetChannels({ id: [inputChannel] }));
  const returned = Array.isArray(resp?.chats) && resp.chats.length ? resp.chats[0] : null;
  const returnedId = idOf(returned);
  if (!returnedId) throw new Error(`JOIN_CANONICAL_MISMATCH: ${label} returned no chat`);
  if (returnedId !== expectedId) {
    log?.("error", `Canonical mismatch for ${label}: expected=${expectedId} got=${returnedId}`);
    throw new Error(`JOIN_CANONICAL_MISMATCH: ${label} expected=${expectedId} got=${returnedId}`);
  }
  if (returned?.left === true) {
    throw new Error(`JOIN_CANONICAL_MISMATCH: ${label} chat reports left=true after join`);
  }
  return returnedId;
}

async function joinEntityVerified(
  client: any,
  Api: any,
  entity: any,
  label: string,
  path: SmartTelegramJoinResult["path"],
  log?: Logger,
): Promise<SmartTelegramJoinResult> {
  let verifiedEntity = entity;
  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
  } catch (error) {
    const msg = textOf(error);
    if (/INVITE_REQUEST_SENT|INVITE_REQUEST_ALREADY_SENT|REQUEST_SENT/i.test(msg)) {
      log?.("info", `Join request sent for ${label}; awaiting admin approval`);
      return {
        status: "requested",
        path,
        message: `Join request sent for ${label}`,
        note: "Awaiting admin approval",
        canonicalTarget: typeof label === "string" && label.startsWith("@") ? label.slice(1) : null,
        errorCode: "INVITE_REQUEST_SENT",
        verified: false,
        canonicalChannelId: null,
      };
    }
    if (!/USER_ALREADY_PARTICIPANT/i.test(msg)) throw error;
  }
  let verified = await waitForMembership(client, Api, verifiedEntity);
  if (!verified && typeof label === "string" && label.startsWith("@")) {
    try {
      verifiedEntity = await client.getEntity(label.slice(1));
      verified = await waitForMembership(client, Api, verifiedEntity);
    } catch {}
  }
  if (!verified) {
    log?.("warn", `Join accepted for ${label}, but membership sync is still pending (path=${path})`);
    return {
      status: "joined",
      path,
      message: `Join accepted for ${label}`,
      note: "Membership verification pending",
      canonicalTarget: typeof label === "string" && label.startsWith("@") ? label.slice(1) : null,
      errorCode: "VERIFY_PENDING",
      verified: false,
      canonicalChannelId: idOf(verifiedEntity),
    };
  }
  const canonicalChannelId = await verifyCanonicalMatch(client, Api, verifiedEntity, label, log);
  log?.("success", `Verified joined ${label} (path=${path}, channelId=${canonicalChannelId})`);
  return {
    status: "joined",
    path,
    message: `Joined ${label}`,
    note: null,
    canonicalTarget: typeof label === "string" && label.startsWith("@") ? label.slice(1) : null,
    errorCode: null,
    verified: true,
    canonicalChannelId,
  };
}

async function findPublicUsernameByInvitePreview(client: any, Api: any, inviteInfo: any): Promise<any | null> {
  const title = String(inviteInfo?.title ?? "").trim();
  if (!title || inviteInfo?.public !== true) return null;
  try {
    const found: any = await client.invoke(new Api.contacts.Search({ q: title, limit: 10 }));
    const chats: any[] = Array.isArray(found?.chats) ? found.chats : [];
    const wantedTitle = cleanTitle(title);
    const wantedCount = Number(inviteInfo?.participantsCount ?? 0);
    const candidates = chats
      .filter((chat) => chat?.username && cleanTitle(chat?.title) === wantedTitle)
      .map((chat) => {
        const count = Number(chat?.participantsCount ?? chat?.participants_count ?? 0);
        const countDistance = wantedCount && count ? Math.abs(count - wantedCount) : Number.MAX_SAFE_INTEGER;
        return { chat, countDistance };
      })
      .sort((a, b) => a.countDistance - b.countDistance);
    return candidates[0]?.chat ?? null;
  } catch {
    return null;
  }
}

export async function joinTelegramTargetVerified(args: {
  client: any;
  Api: any;
  target: string;
  publicInviteFallback?: boolean;
  log?: Logger;
}): Promise<SmartTelegramJoinResult> {
  const { client, Api, log } = args;
  const target = args.target
    .trim()
    .replace(/^@/, "")
    .replace(/[?#].*$/, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "");
  const inviteHash = target.startsWith("+")
    ? target.slice(1)
    : target.toLowerCase().startsWith("joinchat/")
      ? target.slice("joinchat/".length)
      : null;

  if (!inviteHash) {
    const entity = await client.getEntity(target);
    return joinEntityVerified(client, Api, entity, `@${target}`, "direct_username", log);
  }

  let peekInfo: any = null;
  if (args.publicInviteFallback !== false) {
    try {
      peekInfo = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
      const chat = firstChatFrom(peekInfo);
      const cn = classNameOf(peekInfo);

      if (cn === "ChatInviteAlready" && chat) {
      const verified = await waitForMembership(client, Api, chat);
        if (!verified) {
          return {
            status: "already",
            path: "peek_already",
            message: `Already member of ${chat.username ? "@" + chat.username : chat.title || "channel"}`,
            note: "Membership verification pending",
            canonicalTarget: chat.username ?? null,
            errorCode: "VERIFY_PENDING",
            verified: false,
            canonicalChannelId: idOf(chat),
          };
        }
        const canonicalChannelId = await verifyCanonicalMatch(
          client,
          Api,
          chat,
          chat?.username ? "@" + chat.username : chat?.title ?? `+${inviteHash.slice(0, 8)}…`,
          log,
        );
        return {
          status: "already",
          path: "peek_already",
          message: `Already member of ${chat.username ? "@" + chat.username : chat.title || "channel"}`,
          note: null,
          canonicalTarget: chat.username ?? null,
          errorCode: null,
          verified: true,
          canonicalChannelId,
        };
      }

      if (chat?.username) {
        const entity = await client.getEntity(chat.username);
        return joinEntityVerified(client, Api, entity, `@${chat.username}`, "peek_username", log);
      }

      if (chat && cn === "ChatInvitePeek") {
        try {
          return await joinEntityVerified(client, Api, chat, chat.title || "channel", "peek_chat", log);
        } catch (error) {
          log?.("info", `Peek chat join did not verify (${extractTelegramErrorCode(textOf(error)) ?? "err"}); trying invite import…`);
        }
      }

      const searched = await findPublicUsernameByInvitePreview(client, Api, peekInfo);
      if (searched?.username) {
        const entity = await client.getEntity(searched.username);
        return joinEntityVerified(client, Api, entity, `@${searched.username}`, "peek_search_username", log);
      }
    } catch (error) {
      log?.("info", `Invite peek/fallback failed (${extractTelegramErrorCode(textOf(error)) ?? "err"}); trying ImportChatInvite…`);
    }
  }

  try {
    const imported: any = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
    const importedChat = firstChatFrom(imported);
    if (importedChat?.username) {
      const entity = await client.getEntity(importedChat.username);
      return joinEntityVerified(client, Api, entity, `@${importedChat.username}`, "import_username", log);
    }
    if (importedChat) {
      const verified = await waitForMembership(client, Api, importedChat);
      if (!verified) {
        return {
          status: "joined",
          path: "import_invite",
          message: `Join accepted for invite +${inviteHash.slice(0, 8)}…`,
          note: "Membership verification pending",
          canonicalTarget: importedChat.username ?? null,
          errorCode: "VERIFY_PENDING",
          verified: false,
          canonicalChannelId: idOf(importedChat),
        };
      }
      const canonicalChannelId = await verifyCanonicalMatch(
        client,
        Api,
        importedChat,
        `+${inviteHash.slice(0, 8)}…`,
        log,
      );
      return {
        status: "joined",
        path: "import_invite",
        message: `Joined invite +${inviteHash.slice(0, 8)}…`,
        note: null,
        canonicalTarget: importedChat.username ?? null,
        errorCode: null,
        verified: true,
        canonicalChannelId,
      };
    }
    throw new Error(`JOIN_NOT_VERIFIED: +${inviteHash.slice(0, 8)}… returned no chat`);
  } catch (error) {
    const msg = textOf(error);
    if (/INVITE_REQUEST_SENT|INVITE_REQUEST_ALREADY_SENT|REQUEST_SENT/i.test(msg)) {
      return {
        status: "requested",
        path: "import_invite",
        message: `Join request sent for +${inviteHash.slice(0, 8)}…`,
        note: "waiting for channel approval",
        canonicalTarget: null,
        errorCode: extractTelegramErrorCode(msg),
        verified: false,
        canonicalChannelId: null,
      };
    }
    throw error;
  }
}