import { ArrowLeft, Loader2, Settings } from "lucide-react";
import type { MiniAppBridge } from "@/lib/telegram-webview-bridge";

/**
 * Renders the pieces of the Telegram client UI that a mini app expects the
 * host to draw: native popups (alerts, confirms, "Allow messaging"), the
 * Main/Secondary buttons and the Back/Settings buttons. Without these the
 * mini app's promises never resolve and the app appears frozen.
 */
export function MiniAppChrome({ bridge }: { bridge: MiniAppBridge }) {
  const { popup, answerPopup, mainButton, secondaryButton, backButtonVisible, settingsButtonVisible, press } =
    bridge;

  const showMain = mainButton?.isVisible && (mainButton.text ?? "").trim().length > 0;
  const showSecondary = secondaryButton?.isVisible && (secondaryButton.text ?? "").trim().length > 0;

  return (
    <>
      {(backButtonVisible || settingsButtonVisible) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between p-1.5">
          {backButtonVisible ? (
            <button
              type="button"
              className="pointer-events-auto rounded-full bg-background/85 p-1.5 shadow backdrop-blur hover:bg-background"
              title="Back"
              onClick={() => press("back")}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : (
            <span />
          )}
          {settingsButtonVisible && (
            <button
              type="button"
              className="pointer-events-auto rounded-full bg-background/85 p-1.5 shadow backdrop-blur hover:bg-background"
              title="Settings"
              onClick={() => press("settings")}
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {(showMain || showSecondary) && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex gap-2 bg-gradient-to-t from-background/95 to-transparent p-2">
          {showSecondary && (
            <button
              type="button"
              disabled={secondaryButton?.isActive === false}
              onClick={() => press("secondary")}
              className="flex-1 rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50"
              style={{
                background: secondaryButton?.color,
                color: secondaryButton?.textColor,
              }}
            >
              {secondaryButton?.text}
            </button>
          )}
          {showMain && (
            <button
              type="button"
              disabled={mainButton?.isActive === false}
              onClick={() => press("main")}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              style={{
                background: mainButton?.color || "hsl(var(--primary))",
                color: mainButton?.textColor,
              }}
            >
              {mainButton?.isProgressVisible && <Loader2 className="h-4 w-4 animate-spin" />}
              {mainButton?.text}
            </button>
          )}
        </div>
      )}

      {popup && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xs overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
            <div className="space-y-1.5 p-4">
              {popup.title && <div className="text-base font-semibold">{popup.title}</div>}
              {popup.message && (
                <div className="whitespace-pre-wrap text-sm text-muted-foreground">{popup.message}</div>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-1 border-t border-border p-2">
              {popup.buttons.map((b, i) => (
                <button
                  key={`${b.id}-${i}`}
                  type="button"
                  onClick={() => answerPopup(b.id ?? "")}
                  className={
                    "rounded-md px-3 py-1.5 text-sm font-medium hover:bg-muted " +
                    (b.type === "destructive"
                      ? "text-destructive"
                      : b.type === "cancel" || b.type === "close"
                        ? "text-muted-foreground"
                        : "text-primary")
                  }
                >
                  {b.text}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}