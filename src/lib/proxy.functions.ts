import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const proxyConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("socks5"),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    user: z.string().max(255).optional().or(z.literal("")),
    pass: z.string().max(255).optional().or(z.literal("")),
  }),
  z.object({
    type: z.literal("socks4"),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    user: z.string().max(255).optional().or(z.literal("")),
    pass: z.string().max(255).optional().or(z.literal("")),
  }),
  z.object({
    type: z.literal("mtproxy"),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    secret: z.string().min(1).max(200),
  }),
]);

function ownerScope(ctx: { supabase: any; userId: string }) {
  return ctx.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", ctx.userId)
    .then((r: any) => {
      const roles = (r.data ?? []).map((x: any) => x.role);
      return roles.includes("owner") || roles.includes("admin");
    });
}

/** List proxy status per account (does NOT return credentials). */
export const listAccountProxies = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("telegram_accounts")
      .select("id, first_name, username, phone, proxy_enc")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const { decryptString } = await import("./crypto.server");
    const out: Array<{
      id: string;
      label: string;
      hasProxy: boolean;
      summary: string | null;
    }> = [];
    for (const a of data ?? []) {
      let summary: string | null = null;
      if (a.proxy_enc) {
        try {
          const cfg = JSON.parse(await decryptString(a.proxy_enc));
          summary = `${cfg.type} · ${cfg.host}:${cfg.port}`;
        } catch { summary = "(decrypt error)"; }
      }
      out.push({
        id: a.id,
        label: a.first_name || a.username || a.phone || a.id.slice(0, 8),
        hasProxy: !!a.proxy_enc,
        summary,
      });
    }
    return out;
  });

const setSchema = z.object({
  accountId: z.string().uuid(),
  proxy: proxyConfigSchema,
});

export const setAccountProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { encryptString } = await import("./crypto.server");
    const enc = await encryptString(JSON.stringify(data.proxy));
    const { error } = await context.supabase
      .from("telegram_accounts")
      .update({ proxy_enc: enc })
      .eq("id", data.accountId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

const clearSchema = z.object({ accountId: z.string().uuid() });

export const clearAccountProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => clearSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("telegram_accounts")
      .update({ proxy_enc: null })
      .eq("id", data.accountId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

const bulkSchema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(500),
  proxy: proxyConfigSchema.nullable(),
});

/** Apply/clear the same proxy across many accounts. */
export const bulkSetAccountProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => bulkSchema.parse(d))
  .handler(async ({ data, context }) => {
    let enc: string | null = null;
    if (data.proxy) {
      const { encryptString } = await import("./crypto.server");
      enc = await encryptString(JSON.stringify(data.proxy));
    }
    const { error, count } = await context.supabase
      .from("telegram_accounts")
      .update({ proxy_enc: enc }, { count: "exact" })
      .in("id", data.accountIds)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const, updated: count ?? 0 };
  });

const testSchema = z.object({ accountId: z.string().uuid() });

/** Test the account's stored proxy by opening a client + calling users.GetMe. */
export const testAccountProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => testSchema.parse(d))
  .handler(async ({ data, context }) => {
    const started = Date.now();
    let client: any;
    try {
      const { openClientForAccount } = await import("./cleanup.server");
      client = await openClientForAccount(context.supabase, data.accountId, {
        requireOwnerId: context.userId,
      });
      const me = await client.getMe();
      return {
        ok: true as const,
        ms: Date.now() - started,
        me: { id: String(me?.id ?? ""), username: me?.username ?? null },
      };
    } catch (e) {
      return { ok: false as const, ms: Date.now() - started, error: (e as Error).message };
    } finally {
      try { await client?.disconnect?.(); } catch { /* noop */ }
    }
  });