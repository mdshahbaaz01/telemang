import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  scope: z.string().max(64),
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(300).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Ship a client-side error to server logs. Kept unauthenticated on purpose so
 * boundary failures during hydration / logout can still surface.
 */
export const logClientError = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    // Prefix so it is easy to grep in server-function-logs.
    console.error(
      `[client-error][${data.scope}] ${data.message}`,
      JSON.stringify({
        url: data.url,
        ua: data.userAgent,
        stack: data.stack,
        extra: data.extra,
      }),
    );
    return { ok: true };
  });