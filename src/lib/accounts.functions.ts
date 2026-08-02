import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const startSchema = z.object({
  phone: z.string().min(5).max(20),
  apiId: z.number().int().positive(),
  apiHash: z.string().min(10).max(200),
});

export const startAccountLogin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => startSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Gate: only owner/admin, or approved users under their account limit, may add.
    const [roleRes, setRes, cntRes] = await Promise.all([
      context.supabase.from("user_roles").select("role").eq("user_id", context.userId),
      context.supabase
        .from("user_admin_settings")
        .select("account_add_approved, account_limit")
        .eq("user_id", context.userId)
        .maybeSingle(),
      context.supabase
        .from("telegram_accounts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", context.userId),
    ]);
    const roles = (roleRes.data ?? []).map((r) => r.role);
    const isPrivileged = roles.includes("owner") || roles.includes("admin");
    if (!isPrivileged) {
      const s = setRes.data;
      if (!s || !s.account_add_approved) {
        throw new Error("Account adding is not approved yet. Ask the owner for permission.");
      }
      const limit = s.account_limit ?? 0;
      const cnt = cntRes.count ?? 0;
      if (limit > 0 && cnt >= limit) {
        throw new Error(`Account limit reached (${cnt}/${limit}). Ask the owner to raise your limit.`);
      }
    }

    const { encryptString } = await import("./crypto.server");
    const { createTgClient } = await import("./telegram-client.server");
    const { StringSession } = await import("telegram/sessions");

    const client = await createTgClient(data.apiId, data.apiHash);
    try {
      const res = await client.sendCode(
        { apiId: data.apiId, apiHash: data.apiHash },
        data.phone,
      );
      const sess = (client.session as InstanceType<typeof StringSession>).save();
      const api_hash_enc = await encryptString(data.apiHash);
      const session_enc = await encryptString(sess);
      const { data: row, error } = await context.supabase
        .from("login_attempts")
        .insert({
          user_id: context.userId,
          phone: data.phone,
          api_id: data.apiId,
          api_hash_enc,
          session_enc,
          phone_code_hash: res.phoneCodeHash,
          stage: "code_sent",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { attemptId: row.id as string };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

const verifySchema = z.object({
  attemptId: z.string().uuid(),
  code: z.string().min(3).max(10),
  password: z.string().optional(),
});

export const verifyAccountLogin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => verifySchema.parse(d))
  .handler(async ({ data, context }) => {
    const { encryptString, decryptString } = await import("./crypto.server");
    const { createTgClient } = await import("./telegram-client.server");
    const { StringSession } = await import("telegram/sessions");
    const { Api } = await import("telegram");

    const { data: att, error: aerr } = await context.supabase
      .from("login_attempts")
      .select("*")
      .eq("id", data.attemptId)
      .single();
    if (aerr || !att) throw new Error("Login attempt not found");

    const apiHash = await decryptString(att.api_hash_enc);
    const sessionStr = att.session_enc ? await decryptString(att.session_enc) : "";
    const client = await createTgClient(att.api_id, apiHash, sessionStr, att.id);

    try {
      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: att.phone,
            phoneCodeHash: att.phone_code_hash!,
            phoneCode: data.code,
          }),
        );
      } catch (e) {
        const msg = (e as Error).message || "";
        if (msg.includes("SESSION_PASSWORD_NEEDED")) {
          if (!data.password) {
            return { needs2FA: true };
          }
          const pw = await client.invoke(new Api.account.GetPassword());
          const { computeCheck } = await import("telegram/Password");
          const check = await computeCheck(pw, data.password);
          await client.invoke(new Api.auth.CheckPassword({ password: check }));
        } else {
          throw e;
        }
      }

      const me = (await client.getMe()) as {
        firstName?: string;
        lastName?: string;
        username?: string;
        id?: { toString: () => string } | string | number | bigint;
      };
      const savedSession = (
        client.session as InstanceType<typeof StringSession>
      ).save();
      const session_enc = await encryptString(savedSession);
      const api_hash_enc = await encryptString(apiHash);

      const { error: uerr } = await context.supabase
        .from("telegram_accounts")
        .upsert(
          {
            user_id: context.userId,
            phone: att.phone,
            api_id: att.api_id,
            api_hash_enc,
            session_enc,
            first_name: me.firstName ?? null,
            last_name: me.lastName ?? null,
            username: me.username ?? null,
            telegram_user_id:
              me.id != null ? Number(typeof me.id === "object" ? me.id.toString() : me.id) : null,
            status: "active",
            last_error: null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,phone" },
        );
      if (uerr) throw new Error(uerr.message);
      await context.supabase.from("login_attempts").delete().eq("id", att.id);
      return { success: true };
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Auto-clear expired flood-wait pauses so cards stop showing stale "FloodWait Xs".
    const nowIso = new Date().toISOString();
    await context.supabase
      .from("telegram_accounts")
      .update({ paused_until: null, last_error: null })
      .lt("paused_until", nowIso)
      .not("paused_until", "is", null)
      .ilike("last_error", "%flood%");
    const { data, error } = await context.supabase
      .from("telegram_accounts")
      .select(
        "id, phone, first_name, last_name, username, telegram_user_id, status, paused_until, last_error, created_at, updated_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("telegram_accounts")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const refreshSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

/** Pull fresh first/last name + username from Telegram and store them. */
export const refreshAccountInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => refreshSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const results: Array<{ id: string; ok: boolean; name?: string; message?: string }> = [];
    for (const id of data.ids) {
      try {
        const client = await openClientForAccount(context.supabase, id);
        try {
          const me = (await client.getMe()) as {
            firstName?: string;
            lastName?: string;
            username?: string;
            id?: { toString: () => string } | string | number | bigint;
          };
          const tgId =
            me?.id != null ? Number(typeof me.id === "object" ? me.id.toString() : me.id) : null;
          const { error } = await context.supabase
            .from("telegram_accounts")
            .update({
              first_name: me.firstName ?? null,
              last_name: me.lastName ?? null,
              username: me.username ?? null,
              ...(tgId != null && Number.isFinite(tgId) ? { telegram_user_id: tgId } : {}),
              status: "active",
              last_error: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id);
          if (error) throw new Error(error.message);
          results.push({
            id,
            ok: true,
            name: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "",
          });
        } finally {
          await client.disconnect().catch(() => {});
        }
      } catch (e) {
        results.push({ id, ok: false, message: (e as Error).message });
      }
    }
    return { results };
  });

export const backfillTelegramIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { decryptString } = await import("./crypto.server");
    const { createTgClient } = await import("./telegram-client.server");

    const { data: rows, error } = await context.supabase
      .from("telegram_accounts")
      .select("id, api_id, api_hash_enc, session_enc, telegram_user_id")
      .is("telegram_user_id", null);
    if (error) throw new Error(error.message);

    let updated = 0;
    let failed = 0;
    for (const row of rows ?? []) {
      if (!row.session_enc) {
        failed++;
        continue;
      }
      try {
        const apiHash = await decryptString(row.api_hash_enc);
        const sessionStr = await decryptString(row.session_enc);
        const client = await createTgClient(row.api_id, apiHash, sessionStr, row.id);
        try {
          const me = (await client.getMe()) as {
            id?: { toString: () => string } | string | number | bigint;
          };
          const tgId =
            me?.id != null
              ? Number(typeof me.id === "object" ? me.id.toString() : me.id)
              : null;
          if (tgId != null && Number.isFinite(tgId)) {
            await context.supabase
              .from("telegram_accounts")
              .update({ telegram_user_id: tgId })
              .eq("id", row.id);
            updated++;
          } else {
            failed++;
          }
        } finally {
          await client.disconnect().catch(() => {});
        }
      } catch {
        failed++;
      }
    }
    return { updated, failed, total: rows?.length ?? 0 };
  });