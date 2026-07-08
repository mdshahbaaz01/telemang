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
    const client = await createTgClient(att.api_id, apiHash, sessionStr);

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