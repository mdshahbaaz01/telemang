import { useEffect, useRef } from "react";

// Minimal Telegram Mini App host bridge. Real telegram-web-app.js posts events
// to `window.parent` (or window.TelegramWebviewProxy / window.external). In a
// plain iframe nobody replies, so apps hang before rendering the referral flow.
// We answer the handful of events every mini app waits for on boot.

type ThemeParams = Record<string, string>;

const DEFAULT_THEME: ThemeParams = {
  bg_color: "#ffffff",
  secondary_bg_color: "#f1f1f1",
  text_color: "#000000",
  hint_color: "#707579",
  link_color: "#3390ec",
  button_color: "#3390ec",
  button_text_color: "#ffffff",
  header_bg_color: "#ffffff",
  accent_text_color: "#3390ec",
  section_bg_color: "#ffffff",
  section_header_text_color: "#3390ec",
  subtitle_text_color: "#707579",
  destructive_text_color: "#df3f40",
};

export function useTelegramWebviewBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  opts: {
    theme?: ThemeParams;
    viewportHeight?: number;
    onOpenTgLink?: (url: string) => boolean | void; // return true to intercept
  } = {},
) {
  const theme = opts.theme ?? DEFAULT_THEME;
  const viewportHeight = opts.viewportHeight;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onOpenTgLinkRef = useRef(opts.onOpenTgLink);
  onOpenTgLinkRef.current = opts.onOpenTgLink;

  useEffect(() => {
    function post(target: Window, eventType: string, eventData: unknown = {}) {
      try {
        target.postMessage(JSON.stringify({ eventType, eventData }), "*");
      } catch {}
    }

    function onMessage(ev: MessageEvent) {
      const source = ev.source as Window | null;
      const iframe = iframeRef.current;
      if (!iframe || !source || source !== iframe.contentWindow) return;

      let payload: any = ev.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      if (!payload || typeof payload !== "object") return;
      const { eventType, eventData } = payload as { eventType?: string; eventData?: any };
      if (!eventType) return;

      const height =
        viewportHeight ?? iframe.getBoundingClientRect().height ?? window.innerHeight;

      switch (eventType) {
        case "web_app_ready":
        case "iframe_ready":
          post(source, "iframe_will_reload", {});
          post(source, "theme_changed", { theme_params: themeRef.current });
          post(source, "viewport_changed", {
            height,
            width: iframe.getBoundingClientRect().width,
            is_state_stable: true,
            is_expanded: true,
          });
          post(source, "safe_area_changed", { top: 0, bottom: 0, left: 0, right: 0 });
          post(source, "content_safe_area_changed", { top: 0, bottom: 0, left: 0, right: 0 });
          break;
        case "web_app_request_theme":
          post(source, "theme_changed", { theme_params: themeRef.current });
          break;
        case "web_app_request_viewport":
          post(source, "viewport_changed", {
            height,
            width: iframe.getBoundingClientRect().width,
            is_state_stable: true,
            is_expanded: true,
          });
          break;
        case "web_app_request_safe_area":
          post(source, "safe_area_changed", { top: 0, bottom: 0, left: 0, right: 0 });
          break;
        case "web_app_request_content_safe_area":
          post(source, "content_safe_area_changed", { top: 0, bottom: 0, left: 0, right: 0 });
          break;
        case "web_app_expand":
          post(source, "viewport_changed", {
            height,
            width: iframe.getBoundingClientRect().width,
            is_state_stable: true,
            is_expanded: true,
          });
          break;
        case "web_app_open_link":
        case "web_app_open_tg_link": {
          const url = eventData?.url;
          if (typeof url === "string") {
            // Detect Telegram deep links / t.me URLs and hand them to the
            // consumer first so the host tile can render an in-tile chat
            // instead of opening a new tab.
            const isTgLink =
              eventType === "web_app_open_tg_link" ||
              /^tg:\/\//i.test(url) ||
              /^https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i.test(url);
            if (isTgLink && onOpenTgLinkRef.current) {
              try {
                const handled = onOpenTgLinkRef.current(url);
                if (handled !== false) break;
              } catch {}
            }
            try {
              if (!isTgLink) iframe.src = url;
            } catch {}
          }
          break;
        }
        case "web_app_close":
          // Let apps that call close still show their final state; ignore.
          break;
        case "web_app_request_write_access":
          post(source, "write_access_requested", { status: "allowed" });
          break;
        case "web_app_request_phone":
          post(source, "phone_requested", { status: "cancelled" });
          break;
        case "web_app_check_home_screen":
          post(source, "home_screen_checked", { status: "unsupported" });
          break;
        case "web_app_biometry_get_info":
          post(source, "biometry_info_received", { available: false });
          break;
        case "web_app_setup_main_button":
        case "web_app_setup_secondary_button":
        case "web_app_setup_back_button":
        case "web_app_setup_settings_button":
        case "web_app_setup_closing_behavior":
        case "web_app_setup_swipe_behavior":
        case "web_app_set_background_color":
        case "web_app_set_header_color":
        case "web_app_set_bottom_bar_color":
        case "web_app_trigger_haptic_feedback":
        case "web_app_data_send":
        case "web_app_switch_inline_query":
        case "web_app_read_text_from_clipboard":
        case "web_app_share_to_story":
        case "web_app_add_to_home_screen":
          // Acknowledge silently — enough for apps to keep booting.
          break;
        default:
          break;
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef, viewportHeight]);
}