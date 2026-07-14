import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Security response headers applied to every SSR/API/server-fn response.
// CSP intentionally allows 'unsafe-inline' style (Tailwind + shadcn require it)
// and 'unsafe-eval' for WASM/GramJS bundles. Scripts are locked to same-origin.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  // Do not send X-Frame-Options: DENY here. The published app is opened
  // inside Lovable's preview/editor iframe, and XFO cannot express an allowlist.
  // CSP frame-ancestors below keeps framing limited to our app + Lovable hosts.
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.telegram.org https://*.lovable.app https://*.lovable.dev https://ai.gateway.lovable.dev",
    "frame-src 'self' https://telegram.org https://*.telegram.org https://t.me https://*.t.me",
    "worker-src 'self' blob:",
    "frame-ancestors 'self' https://*.lovable.app https://*.lovable.dev https://*.lovableproject.com",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
};

const securityHeadersMiddleware = createMiddleware().server(async ({ next, request }) => {
  const response = await next();
  const res = (response as unknown as { response?: Response }).response ?? (response as unknown as Response);
  if (res && typeof (res as Response).headers?.set === "function") {
    // Do not override CSP on the mini-app proxy (it needs to embed 3rd-party frames).
    const url = new URL(request.url);
    const skipCsp = url.pathname.startsWith("/api/public/miniapp-proxy");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (skipCsp && k === "Content-Security-Policy") continue;
      if (skipCsp && k === "X-Frame-Options") continue;
      if (!(res as Response).headers.has(k)) (res as Response).headers.set(k, v);
    }
  }
  return response;
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [securityHeadersMiddleware, errorMiddleware],
}));
