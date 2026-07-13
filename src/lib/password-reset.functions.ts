import { createServerFn } from "@tanstack/react-start";
import { createHash } from "crypto";
import { z } from "zod";

const inputSchema = z.object({
  email: z.string().trim().email().max(255),
  redirectTo: z.string().url().max(2048),
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