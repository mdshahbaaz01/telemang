import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Authenticated: mint a short-lived HMAC token that authorizes the caller
// to use the /api/public/miniapp-proxy/ endpoint. Ownership of a specific
// Telegram account is not enforced here (the proxy is a rendering helper),
// but only signed-in users of this app can obtain a token.
export const mintMiniAppProxyToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({}).parse(input ?? {}))
  .handler(async () => {
    const { signMiniAppProxyToken } = await import("@/lib/miniapp-token.server");
    return signMiniAppProxyToken();
  });