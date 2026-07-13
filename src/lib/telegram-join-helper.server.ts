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

async function joinEntityVerified(
  client: any,
  Api: any,
  entity: any,
  label: string,
  path: SmartTelegramJoinResult["path"],
  log?: Logger,
): Promise<SmartTelegramJoinResult> {
  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
  } catch (error) {
    const msg = textOf(error);
    if (!/USER_ALREADY_PARTICIPANT/i.test(msg)) throw error;
  }
  const verified = await verifyMembership(client, Api, entity);
  if (!verified) throw new Error(`JOIN_NOT_VERIFIED: ${label}`);
  log?.("success", `Verified joined ${label} (path=${path})`);
  return {
    status: "joined",
    path,
    message: `Joined ${label}`,
    note: null,
    canonicalTarget: typeof label === "string" && label.startsWith("@") ? label.slice(1) : null,
    errorCode: null,
    verified: true,
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
        const verified = await verifyMembership(client, Api, chat);
        if (!verified) throw new Error(`JOIN_NOT_VERIFIED: already ${chat?.username ? "@" + chat.username : chat?.title ?? inviteHash}`);
        return {
          status: "already",
          path: "peek_already",
          message: `Already member of ${chat.username ? "@" + chat.username : chat.title || "channel"}`,
          note: null,
          canonicalTarget: chat.username ?? null,
          errorCode: null,
          verified: true,
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
      const verified = await verifyMembership(client, Api, importedChat);
      if (!verified) throw new Error(`JOIN_NOT_VERIFIED: +${inviteHash.slice(0, 8)}…`);
      return {
        status: "joined",
        path: "import_invite",
        message: `Joined invite +${inviteHash.slice(0, 8)}…`,
        note: null,
        canonicalTarget: importedChat.username ?? null,
        errorCode: null,
        verified: true,
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
      };
    }
    throw error;
  }
}