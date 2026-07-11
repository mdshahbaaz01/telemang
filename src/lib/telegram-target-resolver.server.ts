function cleanTarget(target: string) {
  return target.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
}

function idText(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function idsMatch(left: unknown, right: string) {
  return idText(left) === right;
}

async function tryGetInputEntity(client: any, value: unknown) {
  try {
    return await client.getInputEntity(value as never);
  } catch {
    return null;
  }
}

function findUser(users: any[] | undefined, idStr: string) {
  return (users ?? []).find((user) => idsMatch(user?.id, idStr));
}

async function scanDialogsForNumericTarget(client: any, Api: any, idStr: string) {
  let dialogs: any[] = [];
  try {
    dialogs = await client.getDialogs({ limit: 1000 });
  } catch {
    dialogs = [];
  }

  const numericId = Number(idStr);
  const afterDialogPrime = await tryGetInputEntity(client, numericId);
  if (afterDialogPrime) return afterDialogPrime;

  for (const dialog of dialogs) {
    const entity = dialog?.entity ?? dialog;
    if (entity?.id != null && idsMatch(entity.id, idStr)) {
      const direct = await tryGetInputEntity(client, entity);
      if (direct) return direct;
    }
  }

  if (idStr.startsWith("-")) return null;

  const { default: bigInt } = await import("big-integer");
  const inputUser = new Api.InputUser({ userId: bigInt(idStr), accessHash: bigInt.zero });
  const scanLimit = 80;
  let scanned = 0;

  for (const dialog of dialogs) {
    if (scanned >= scanLimit) break;
    const entity = dialog?.entity ?? dialog;
    if (!entity) continue;

    if (entity.className === "Channel" && (entity.megagroup || entity.gigagroup)) {
      scanned++;
      try {
        const res: any = await client.invoke(
          new Api.channels.GetParticipant({ channel: entity, participant: inputUser }),
        );
        const user = findUser(res?.users, idStr);
        if (user) {
          const resolved = (await tryGetInputEntity(client, user)) ?? (await tryGetInputEntity(client, numericId));
          if (resolved) return resolved;
        }
      } catch {
        // Hidden members / no rights / not a participant in this group.
      }
      continue;
    }

    if (entity.className === "Chat") {
      scanned++;
      try {
        const res: any = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
        const user = findUser(res?.users, idStr);
        if (user) {
          const resolved = (await tryGetInputEntity(client, user)) ?? (await tryGetInputEntity(client, numericId));
          if (resolved) return resolved;
        }
      } catch {
        // Ignore chats that cannot expose member data.
      }
    }
  }

  return null;
}

function numericTargetError(idStr: string) {
  if (idStr.startsWith("-")) {
    return `Chat/channel ID ${idStr} not reachable from this account. Use a t.me/c/... post link, @username, invite link, or pick it from that account's chats.`;
  }
  return `ID ${idStr} not reachable from this account. I checked dialogs and visible group members, but Telegram did not provide an access_hash. Open a DM first, use @username/t.me link, add the user as contact by phone, or pick an existing chat from that account.`;
}

export async function resolveTargetEntity(client: any, Api: any, target: string) {
  const cleaned = cleanTarget(target);

  const numMatch = cleaned.match(/^(?:user:|id:)?(-?\d+)$/i);
  if (numMatch) {
    const idStr = numMatch[1];
    const numericId = Number(idStr);
    const cached = await tryGetInputEntity(client, numericId);
    if (cached) return cached;

    const scanned = await scanDialogsForNumericTarget(client, Api, idStr);
    if (scanned) return scanned;

    throw new Error(numericTargetError(idStr));
  }

  const inviteMatch = cleaned.match(/^(?:joinchat\/)?\+?([A-Za-z0-9_-]{16,})$/);
  if (cleaned.startsWith("+") || cleaned.startsWith("joinchat/")) {
    const hash = inviteMatch ? inviteMatch[1] : cleaned.replace(/^\+/, "").replace(/^joinchat\//, "");
    try {
      const info: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
      if (info?.chat) return info.chat;
      const upd: any = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      const chat = upd?.chats?.[0];
      if (chat) return chat;
    } catch (e: any) {
      const msg = String(e?.errorMessage || e?.message || e);
      if (msg.includes("INVITE_HASH_EXPIRED") || msg.includes("INVITE_HASH_INVALID")) {
        throw new Error(`Invite link expired or invalid: ${target}`);
      }
      if (msg.includes("USER_ALREADY_PARTICIPANT")) {
        const info: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
        if (info?.chat) return info.chat;
      }
      throw e;
    }
    throw new Error(`Could not resolve invite link: ${target}`);
  }

  if (/^c\/\d+/.test(cleaned)) {
    const raw = cleaned.split("/")[1];
    const { default: bigInt } = await import("big-integer");
    try {
      return await client.getEntity(new Api.PeerChannel({ channelId: bigInt(raw) }));
    } catch {
      return await client.getEntity(`https://t.me/${cleaned}`);
    }
  }

  return await client.getEntity(cleaned);
}