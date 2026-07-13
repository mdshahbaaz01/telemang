import { logClientError } from "@/lib/client-error-log.functions";

let installed = false;

/**
 * Global fallback: any uncaught error or rejection whose message / stack
 * mentions captcha bits gets tagged and shipped to server logs. This catches
 * failures that happen outside a React tree (proxy iframe callbacks, timer
 * callbacks, dynamic imports, etc.) so the user always has a signal.
 */
export function installCaptchaErrorListeners() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const CAPTCHA_HINTS = /captcha|recaptcha|hcaptcha|turnstile|geetest|funcaptcha/i;

  const looksLikeCaptcha = (msg: string, stack?: string) =>
    CAPTCHA_HINTS.test(msg) || (!!stack && CAPTCHA_HINTS.test(stack));

  window.addEventListener("error", (event) => {
    const err = event.error as Error | undefined;
    const msg = err?.message ?? String(event.message ?? "");
    const stack = err?.stack;
    if (!looksLikeCaptcha(msg, stack)) return;
    // eslint-disable-next-line no-console
    console.error("[CAPTCHA][window.error]", msg, stack);
    void logClientError({
      data: {
        scope: "captcha:window",
        message: msg,
        stack,
        url: window.location.href,
        userAgent: navigator.userAgent,
        extra: { source: event.filename, line: event.lineno, col: event.colno },
      },
    }).catch(() => undefined);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    if (!looksLikeCaptcha(msg, stack)) return;
    // eslint-disable-next-line no-console
    console.error("[CAPTCHA][unhandledrejection]", msg, stack);
    void logClientError({
      data: {
        scope: "captcha:rejection",
        message: msg,
        stack,
        url: window.location.href,
        userAgent: navigator.userAgent,
      },
    }).catch(() => undefined);
  });
}