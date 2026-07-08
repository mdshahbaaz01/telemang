import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

export async function createTgClient(
  apiId: number,
  apiHash: string,
  sessionStr = "",
): Promise<TelegramClient> {
  const client = new TelegramClient(
    new StringSession(sessionStr),
    apiId,
    apiHash,
    {
      connectionRetries: 2,
      useWSS: true,
      // Never let GramJS sleep inside a request on FloodWait; surface it so the UI can pause/skip cleanly.
      floodSleepThreshold: 0,
      // Suppress internal chatty logs
      baseLogger: undefined as unknown as never,
    },
  );
  await client.connect();
  return client;
}