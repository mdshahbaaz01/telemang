import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const fieldsSchema = z.object({
  firstName: z.string().max(64).optional(),
  lastName: z.string().max(64).optional(),
  bio: z.string().max(70).optional(),
  username: z
    .string()
    .max(32)
    .regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/, "Username must be 4-32 chars, start with a letter, letters/digits/underscore only")
    .optional()
    .or(z.literal("")),
  avatarPath: z.string().max(500).optional(),
});

const bulkSchema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(500),
  fields: fieldsSchema,
});

export const updateProfileBulk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => bulkSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { openClientForAccount } = await import("./cleanup.server");
    const { Api } = await import("telegram");
    const { CustomFile } = await import("telegram/client/uploads");

    let avatarBuf: Buffer | null = null;
    let avatarName = "avatar.jpg";
    if (data.fields.avatarPath) {
      const { data: signed, error } = await context.supabase.storage
        .from("action-attachments")
        .createSignedUrl(data.fields.avatarPath, 300);
      if (error || !signed?.signedUrl) throw new Error(`Avatar fetch failed: ${error?.message ?? "no url"}`);
      const res = await fetch(signed.signedUrl);
      if (!res.ok) throw new Error(`Avatar download failed: ${res.status}`);
      avatarBuf = Buffer.from(await res.arrayBuffer());
      const nameFromPath = data.fields.avatarPath.split("/").pop();
      if (nameFromPath) avatarName = nameFromPath;
    }

    const results: Array<{ accountId: string; ok: boolean; message: string }> = [];

    await Promise.all(
      data.accountIds.map(async (accountId) => {
        let client;
        try {
          client = await openClientForAccount(context.supabase, accountId, { requireOwnerId: context.userId });
        } catch (e) {
          results.push({ accountId, ok: false, message: `Connect failed: ${(e as Error).message}` });
          return;
        }
        try {
          if (data.fields.firstName != null || data.fields.lastName != null || data.fields.bio != null) {
            await client.invoke(
              new Api.account.UpdateProfile({
                firstName: data.fields.firstName,
                lastName: data.fields.lastName,
                about: data.fields.bio,
              }),
            );
          }
          if (data.fields.username != null) {
            const desired = data.fields.username || "";
            try {
              if (desired) {
                // Pre-check availability so we surface a clear reason instead of a raw RPC error.
                try {
                  const avail = await client.invoke(new Api.account.CheckUsername({ username: desired }));
                  if (avail === false) {
                    // false = taken by someone else (true = free, or already yours in some cases)
                    const me = await client.getMe().catch(() => null) as { username?: string } | null;
                    if (me?.username?.toLowerCase() === desired.toLowerCase()) {
                      // Already ours — skip UpdateUsername (would throw USERNAME_NOT_MODIFIED)
                    } else {
                      results.push({ accountId, ok: false, message: `Username @${desired} is already taken` });
                      return;
                    }
                  } else {
                    await client.invoke(new Api.account.UpdateUsername({ username: desired }));
                  }
                } catch (inner) {
                  const msg = (inner as Error).message || "";
                  if (/USERNAME_NOT_MODIFIED/i.test(msg)) {
                    // no-op
                  } else {
                    let friendly = msg;
                    if (/USERNAME_INVALID/i.test(msg)) friendly = "Invalid username (4-32 chars, must start with a letter)";
                    else if (/USERNAME_OCCUPIED/i.test(msg)) friendly = `Username @${desired} is already taken`;
                    else if (/USERNAME_PURCHASE_AVAILABLE/i.test(msg)) friendly = `@${desired} is a Fragment auction username — buy it on Fragment first`;
                    else if (/FLOOD_WAIT_(\d+)/i.test(msg)) friendly = `Flood wait: try again later (${msg})`;
                    results.push({ accountId, ok: false, message: `Username: ${friendly}` });
                    return;
                  }
                }
              } else {
                // Clear the username
                await client.invoke(new Api.account.UpdateUsername({ username: "" }));
              }
            } catch (e) {
              results.push({ accountId, ok: false, message: `Username: ${(e as Error).message}` });
              return;
            }
          }
          if (avatarBuf) {
            const uploaded = await client.uploadFile({
              file: new CustomFile(avatarName, avatarBuf.length, avatarName, avatarBuf),
              workers: 1,
            });
            await client.invoke(new Api.photos.UploadProfilePhoto({ file: uploaded }));
          }
          results.push({ accountId, ok: true, message: "Updated" });
        } catch (e) {
          results.push({ accountId, ok: false, message: (e as Error).message });
        } finally {
          await client.disconnect().catch(() => {});
        }
      }),
    );

    return { results };
  });