import { webcrypto } from "crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function getKey(): Promise<CryptoKey> {
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!raw) throw new Error("SESSION_ENCRYPTION_KEY not configured");
  const hash = await webcrypto.subtle.digest("SHA-256", enc.encode(raw));
  return webcrypto.subtle.importKey("raw", hash, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function encryptString(plain: string): Promise<string> {
  const key = await getKey();
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plain),
  );
  return `${b64(iv)}:${b64(ct)}`;
}

export async function decryptString(payload: string): Promise<string> {
  const [ivB64, ctB64] = payload.split(":");
  const key = await getKey();
  const pt = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(ivB64) },
    key,
    unb64(ctB64),
  );
  return dec.decode(pt);
}