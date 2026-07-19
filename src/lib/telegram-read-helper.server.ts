// Marks a peer's history as read before performing an interaction.
// Returns a status so callers can surface a visible per-account indicator
// (pending → read | failed | skipped).
import { Api } from "telegram";

export type ReadStatus = "read" | "failed" | "skipped";

export type ReadEmit = (phase: "pending" | ReadStatus) => void;

export async function markPeerRead(
  client: any,
  peer: any,
  maxId: number = 0,
  emit?: ReadEmit,
): Promise<ReadStatus> {
  if (!client || !peer) {
    emit?.("skipped");
    return "skipped";
  }
  emit?.("pending");
  const isChannel =
    peer?.className === "InputPeerChannel" ||
    peer?.className === "InputPeerChannelFromMessage" ||
    typeof peer?.channelId !== "undefined";
  if (isChannel) {
    try {
      await client.invoke(
        new Api.channels.ReadHistory({ channel: peer, maxId } as any),
      );
      emit?.("read");
      return "read";
    } catch {
      /* fall through */
    }
  }
  try {
    await client.invoke(
      new Api.messages.ReadHistory({ peer, maxId } as any),
    );
    emit?.("read");
    return "read";
  } catch {
    try {
      await client.invoke(
        new Api.channels.ReadHistory({ channel: peer, maxId } as any),
      );
      emit?.("read");
      return "read";
    } catch {
      emit?.("failed");
      return "failed";
    }
  }
}

export async function markEntityRead(client: any, entity: any): Promise<ReadStatus> {
  try {
    const peer = await client.getInputEntity(entity);
    return await markPeerRead(client, peer);
  } catch {
    return "failed";
  }
}