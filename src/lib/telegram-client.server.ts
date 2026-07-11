import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

// Deterministic per-account device identity so Telegram treats every account
// as a distinct physical device (separate entry in "Active sessions").
function deriveDevice(key: string) {
  // Simple djb2 hash → deterministic pick from small pools.
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  const models = [
    "iPhone 15 Pro", "iPhone 14", "iPhone 13 Pro Max", "Pixel 8 Pro",
    "Pixel 7", "Samsung Galaxy S24 Ultra", "Samsung Galaxy S23", "OnePlus 12",
    "Xiaomi 14 Pro", "Redmi Note 13 Pro", "Nothing Phone 2", "iPad Pro",
    "MacBook Pro", "ThinkPad X1", "Surface Pro 9", "Realme GT 5",
  ];
  const iosVersions = ["17.4", "17.5.1", "18.0", "18.1", "16.7.8"];
  const androidVersions = ["Android 13", "Android 14", "Android 15", "Android 12"];
  const macVersions = ["macOS 14.5", "macOS 14.6", "macOS 15.0"];
  const winVersions = ["Windows 11", "Windows 10"];
  const model = models[h % models.length];
  const isApple = model.includes("iPhone") || model.includes("iPad");
  const isMac = model.includes("MacBook");
  const isWin = model.includes("ThinkPad") || model.includes("Surface");
  const sysVer = isApple
    ? `iOS ${iosVersions[h % iosVersions.length]}`
    : isMac
      ? macVersions[h % macVersions.length]
      : isWin
        ? winVersions[h % winVersions.length]
        : androidVersions[h % androidVersions.length];
  const appMajor = 10 + (h % 3);
  const appMinor = h % 10;
  const appPatch = (h >> 3) % 10;
  return {
    deviceModel: model,
    systemVersion: sysVer,
    appVersion: `${appMajor}.${appMinor}.${appPatch}`,
    langCode: "en",
    systemLangCode: "en-US",
  };
}

export async function createTgClient(
  apiId: number,
  apiHash: string,
  sessionStr = "",
  deviceKey?: string,
): Promise<TelegramClient> {
  const device = deviceKey ? deriveDevice(deviceKey) : {};
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
      ...device,
    },
  );
  await client.connect();
  return client;
}