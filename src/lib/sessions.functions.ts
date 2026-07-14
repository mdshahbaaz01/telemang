import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getRequestHeader } from "@tanstack/react-start/server";

async function sha256Hex(input: string) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clientIpHash(): Promise<string | null> {
  const raw =
    getRequestHeader("cf-connecting-ip") ??
    getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  if (!raw) return Promise.resolve(null);
  return sha256Hex(raw);
}

export const registerSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      sessionKey: z.string().min(8).max(128),
      userAgent: z.string().max(500).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ip = await clientIpHash();
    const keyHash = await sha256Hex(data.sessionKey + ":" + context.userId);
    const { error } = await context.supabase
      .from("user_sessions")
      .upsert(
        {
          user_id: context.userId,
          session_key: keyHash,
          user_agent: data.userAgent ?? null,
          ip_hash: ip,
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
        },
        { onConflict: "user_id,session_key" },
      );
    if (error) throw new Error(error.message);
    return { ok: true, key: keyHash };
  });

export const heartbeatSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ sessionKey: z.string().min(8).max(128) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const keyHash = await sha256Hex(data.sessionKey + ":" + context.userId);
    const { data: row } = await context.supabase
      .from("user_sessions")
      .select("id, revoked_at")
      .eq("user_id", context.userId)
      .eq("session_key", keyHash)
      .maybeSingle();
    if (!row) return { ok: false, revoked: true };
    if (row.revoked_at) return { ok: false, revoked: true };
    await context.supabase
      .from("user_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", row.id);
    return { ok: true, revoked: false };
  });

export const listMySessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_sessions")
      .select("id, session_key, user_agent, ip_hash, last_seen_at, created_at, revoked_at")
      .eq("user_id", context.userId)
      .order("last_seen_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const revokeSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("user_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const revokeOtherSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ currentSessionKey: z.string().min(8).max(128) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const keyHash = await sha256Hex(data.currentSessionKey + ":" + context.userId);
    const { error } = await context.supabase
      .from("user_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", context.userId)
      .neq("session_key", keyHash)
      .is("revoked_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Return current session key from browser localStorage, generating if missing. */
export const CLIENT_SESSION_KEY_STORAGE = "tm.sessionKey.v1";