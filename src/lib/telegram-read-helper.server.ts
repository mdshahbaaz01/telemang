// Marks a peer's history as read before performing an interaction (send/reply/
// forward/react/comment). Best-effort: any failure is swallowed so the caller
// action still proceeds.
import { Api } from "telegram";

export async function markPeerRead(
  client: any,
  peer: any,
  maxId: number = 0,
): Promise<void> {
  if (!client || !peer) return;
  // channels.ReadHistory requires a channel input; messages.ReadHistory works
  // for users and small chats. Try the channel variant first when the peer
  // looks like a channel, otherwise fall back to the generic call.
  const isChannel =
    peer?.className === "InputPeerChannel" ||
    peer?.className === "InputPeerChannelFromMessage" ||
    typeof peer?.channelId !== "undefined";
  try {
    if (isChannel) {
      await client.invoke(
        new Api.channels.ReadHistory({ channel: peer, maxId } as any),
      );
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    await client.invoke(
      new Api.messages.ReadHistory({ peer, maxId } as any),
    );
  } catch {
    // last-resort: try the other variant
    try {
      await client.invoke(
        new Api.channels.ReadHistory({ channel: peer, maxId } as any),
      );
    } catch {
      /* ignore — read is best-effort */
    }
  }
}

// Convenience: resolve a target string/entity then mark read.
export async function markEntityRead(client: any, entity: any): Promise<void> {
  try {
    const peer = await client.getInputEntity(entity);
    await markPeerRead(client, peer);
  } catch {
    /* ignore */
  }
}
