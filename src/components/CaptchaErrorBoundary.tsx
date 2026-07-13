import { Component, type ErrorInfo, type ReactNode } from "react";
import { logClientError } from "@/lib/client-error-log.functions";
import { setBotFlowCaptchaConfig } from "@/lib/bot-flow-captcha-config";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  scope: string;
  children: ReactNode;
  /** When true, auto-disable the captcha feature on the first crash. */
  autoDisable?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors coming from any captcha UI (bot-flow card,
 * solver page, mini-app captcha overlays) so a single bad code path can not
 * black-hole the whole route. Every failure:
 *  - logs a clearly tagged `[CAPTCHA]` message to the browser console with
 *    the full stack (so the user can screenshot it),
 *  - ships the same payload to server logs via `logClientError`,
 *  - optionally flips the global "captcha enabled" switch off so the app
 *    keeps working while the underlying bug is investigated.
 */
export class CaptchaErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 1) Local, always-visible signal.
    // eslint-disable-next-line no-console
    console.error(
      `[CAPTCHA][${this.props.scope}] crash`,
      { message: error.message, stack: error.stack, componentStack: info.componentStack },
    );

    // 2) Server-side signal (fire and forget).
    void logClientError({
      data: {
        scope: `captcha:${this.props.scope}`,
        message: error.message ?? "Unknown captcha error",
        stack: error.stack,
        url: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        extra: { componentStack: info.componentStack ?? undefined },
      },
    }).catch(() => {
      // swallow — we already logged locally
    });

    // 3) Kill switch — turn the feature off so the next render is safe.
    if (this.props.autoDisable) {
      try { setBotFlowCaptchaConfig({ enabled: false }); } catch { /* ignore */ }
    }
  }

  reset = () => this.setState({ error: null });

  disableAndReset = () => {
    try { setBotFlowCaptchaConfig({ enabled: false }); } catch { /* ignore */ }
    this.reset();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
          <div className="text-sm">
            <div className="font-semibold text-destructive">Captcha module crashed</div>
            <div className="text-xs text-muted-foreground mt-1 break-all">
              {this.state.error.message}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              Logged to console and server. Turn the feature off to keep working.
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="destructive" onClick={this.disableAndReset}>
            Disable captcha
          </Button>
          <Button size="sm" variant="outline" onClick={this.reset}>Retry</Button>
        </div>
      </div>
    );
  }
}