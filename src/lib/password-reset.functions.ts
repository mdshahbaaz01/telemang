import { createServerFn } from "@tanstack/react-start";
import { createHash } from "crypto";
import { z } from "zod";

const inputSchema = z.object({
  email: z.string().trim().email().max(255),
  redirectTo: z.string().url().max(2048),
});

const peekSchema = z.object({
  email: z.string().trim().email().max(255),
});

function hashEmail(email: string) {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

/**
 * Server-side rate-limited password reset request.
 * Returns { ok, retryAfter, reason } — never leaks whether the email exists.
 * Limits: 60s between requests + 5 per hour, per email.
 */
export const requestPasswordReset = createServerFn({ method: "POST" })
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const emailHash = hashEmail(data.email);

    const { data: rl, error: rlErr } = await supabaseAdmin.rpc(
      "check_password_reset_rate_limit",
      { _email_hash: emailHash, _min_interval_seconds: 60, _hourly_cap: 5 },
    );

    if (rlErr) {
      console.error("[password-reset] rate-limit rpc failed", rlErr);
      return { ok: false as const, retryAfter: 60, reason: "server_error" as const };
    }

    const result = rl as {
      allowed: boolean;
      retry_after_seconds: number;
      reason?: "cooldown" | "hourly_cap";
    };

    if (!result.allowed) {
      return {
        ok: false as const,
        retryAfter: result.retry_after_seconds,
        reason: result.reason ?? "cooldown",
      };
    }

    // Fire the reset email via admin API. Any provider error is logged but not leaked.
    const { error: sendErr } = await supabaseAdmin.auth.resetPasswordForEmail(data.email, {
      redirectTo: data.redirectTo,
    });
    if (sendErr) {
      console.error("[password-reset] send failed", sendErr.message);
    }

    return { ok: true as const, retryAfter: 60 };
  });

/**
 * Peek remaining cooldown for an email without consuming a slot.
 * Returns seconds until the next request is allowed (0 = ready).
 * Never reveals account existence — only rate-limit state for the hashed email.
 */
export const peekPasswordResetCooldown = createServerFn({ method: "POST" })
  .inputValidator((data) => peekSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const emailHash = hashEmail(data.email);

    const { data: rows, error } = await supabaseAdmin
      .from("password_reset_requests")
      .select("created_at")
      .eq("email_hash", emailHash)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("[password-reset] peek failed", error.message);
      return { retryAfter: 0, hourlyCount: 0, reason: null as null | "cooldown" | "hourly_cap" };
    }

    const list = rows ?? [];
    const hourlyCount = list.length;
    const last = list[0]?.created_at ? new Date(list[0].created_at).getTime() : 0;
    const cooldownRemaining = last
      ? Math.max(0, 60 - Math.floor((Date.now() - last) / 1000))
      : 0;

    if (hourlyCount >= 5) {
      // Roughly: time until the oldest of the last 5 falls out of the 1h window.
      const oldest = new Date(list[list.length - 1].created_at).getTime();
      const secs = Math.max(60, Math.ceil((oldest + 60 * 60 * 1000 - Date.now()) / 1000));
      return { retryAfter: secs, hourlyCount, reason: "hourly_cap" as const };
    }

    return {
      retryAfter: cooldownRemaining,
      hourlyCount,
      reason: cooldownRemaining > 0 ? ("cooldown" as const) : null,
    };
  });