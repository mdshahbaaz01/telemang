import { createHmac, timingSafeEqual } from "crypto";

// Short-lived HMAC token proving the caller was authenticated when they
// requested access to the mini-app proxy. Bound to an expiry timestamp;
// signed with SESSION_ENCRYPTION_KEY (server-only, never in client bundle).

const TTL_SECONDS = 60 * 60; // 1 hour

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secret(): string {
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!raw) throw new Error("SESSION_ENCRYPTION_KEY not configured");
  return raw;
}

export function signMiniAppProxyToken(nowSec = Math.floor(Date.now() / 1000)): {
  token: string;
  expiresAt: number;
} {
  const exp = nowSec + TTL_SECONDS;
  const mac = createHmac("sha256", secret()).update(`miniapp:${exp}`).digest();
  return { token: `${exp}.${b64url(mac)}`, expiresAt: exp };
}

export function verifyMiniAppProxyToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const macStr = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  let expected: Buffer;
  try {
    expected = createHmac("sha256", secret()).update(`miniapp:${exp}`).digest();
  } catch {
    return false;
  }
  let presented: Buffer;
  try {
    presented = Buffer.from(macStr.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return false;
  }
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(presented, expected);
  } catch {
    return false;
  }
}

// Reject hostnames that would let the proxy hit loopback, link-local,
// cloud metadata, or RFC1918 private ranges (SSRF guard).
export function isBlockedProxyHost(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  // IPv6 literals — block loopback, unspecified, link-local, unique-local.
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1);
    if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd")) {
      return true;
    }
  }
  // IPv4 literals.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    void c;
  }
  return false;
}