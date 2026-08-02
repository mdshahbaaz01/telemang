import { useCallback, useEffect, useRef, useState } from "react";

// Minimal Telegram Mini App host bridge. Real telegram-web-app.js posts events
// to `window.parent` (or window.TelegramWebviewProxy / window.external). In a
// plain iframe nobody replies, so apps hang before rendering the referral flow.
// We answer the handful of events every mini app waits for on boot.

type ThemeParams = Record<string, string>;

export type MiniAppPopupButton = { id?: string; type?: string; text?: string };
export type MiniAppPopup = {
  kind: "popup" | "write_access" | "contact" | "qr";
  title?: string;
  message: string;
  buttons: MiniAppPopupButton[];
};
export type MiniAppButtonState = {
  isVisible: boolean;
  isActive?: boolean;
  text?: string;
  color?: string;
  textColor?: string;
  isProgressVisible?: boolean;
};

export type MiniAppBridge = {
  popup: MiniAppPopup | null;
  answerPopup: (buttonId: string) => void;
  mainButton: MiniAppButtonState | null;
  secondaryButton: MiniAppButtonState | null;
  backButtonVisible: boolean;
  settingsButtonVisible: boolean;
  press: (kind: "main" | "secondary" | "back" | "settings") => void;
};

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
    onClose?: () => boolean | void;
    onBlocked?: (details: { reason?: string; text?: string; url?: string }) => void;
  } = {},
): MiniAppBridge {
  const theme = opts.theme ?? DEFAULT_THEME;
  const viewportHeight = opts.viewportHeight;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onOpenTgLinkRef = useRef(opts.onOpenTgLink);
  onOpenTgLinkRef.current = opts.onOpenTgLink;
  const onCloseRef = useRef(opts.onClose);
  onCloseRef.current = opts.onClose;
  const onBlockedRef = useRef(opts.onBlocked);
  onBlockedRef.current = opts.onBlocked;

  const [popup, setPopup] = useState<MiniAppPopup | null>(null);
  const [mainButton, setMainButton] = useState<MiniAppButtonState | null>(null);
  const [secondaryButton, setSecondaryButton] = useState<MiniAppButtonState | null>(null);
  const [backButtonVisible, setBackButtonVisible] = useState(false);
  const [settingsButtonVisible, setSettingsButtonVisible] = useState(false);

  const postToApp = useCallback(
    (eventType: string, eventData: unknown = {}) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage(JSON.stringify({ eventType, eventData }), "*");
      } catch {}
    },
    [iframeRef],
  );

  const answerPopup = useCallback(
    (buttonId: string) => {
      const current = popup;
      setPopup(null);
      if (!current) return;
      if (current.kind === "write_access") {
        postToApp("write_access_requested", {
          status: buttonId === "allow" ? "allowed" : "cancelled",
        });
        return;
      }
      if (current.kind === "contact") {
        postToApp("phone_requested", {
          status: buttonId === "allow" ? "sent" : "cancelled",
        });
        return;
      }
      if (current.kind === "qr") {
        postToApp("scan_qr_popup_closed", {});
        return;
      }
      postToApp("popup_closed", { button_id: buttonId });
    },
    [popup, postToApp],
  );

  const press = useCallback(
    (kind: "main" | "secondary" | "back" | "settings") => {
      postToApp(
        kind === "main"
          ? "main_button_pressed"
          : kind === "secondary"
            ? "secondary_button_pressed"
            : kind === "back"
              ? "back_button_pressed"
              : "settings_button_pressed",
        {},
      );
    },
    [postToApp],
  );

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
          if (onCloseRef.current) {
            try {
              const handled = onCloseRef.current();
              if (handled !== false) break;
            } catch {}
          }
          break;
        case "miniapp_blocked":
          try {
            onBlockedRef.current?.({
              reason: eventData?.reason,
              text: eventData?.text,
              url: eventData?.url,
            });
          } catch {}
          break;
        case "web_app_open_popup": {
          const rawButtons: MiniAppPopupButton[] = Array.isArray(eventData?.buttons)
            ? eventData.buttons
            : [];
          const buttons = rawButtons.length
            ? rawButtons.map((b, i) => ({
                id: b.id ?? String(i),
                type: b.type ?? "default",
                text: b.text ?? (b.type === "close" ? "Close" : b.type === "cancel" ? "Cancel" : "OK"),
              }))
            : [{ id: "", type: "close", text: "OK" }];
          setPopup({
            kind: "popup",
            title: eventData?.title,
            message: String(eventData?.message ?? ""),
            buttons,
          });
          break;
        }
        case "web_app_request_write_access":
          setPopup({
            kind: "write_access",
            title: "Allow messaging",
            message: "Allow this bot to send you messages?",
            buttons: [
              { id: "deny", type: "cancel", text: "Don't Allow" },
              { id: "allow", type: "default", text: "Allow" },
            ],
          });
          break;
        case "web_app_request_phone":
          setPopup({
            kind: "contact",
            title: "Share phone number",
            message: "Share your phone number with this bot?",
            buttons: [
              { id: "deny", type: "cancel", text: "Cancel" },
              { id: "allow", type: "default", text: "Share" },
            ],
          });
          break;
        case "web_app_open_scan_qr_popup":
          setPopup({
            kind: "qr",
            title: "QR scanner",
            message: eventData?.text || "QR scanning is not available in the embedded viewer.",
            buttons: [{ id: "close", type: "close", text: "Close" }],
          });
          break;
        case "web_app_close_scan_qr_popup":
          setPopup((p) => (p?.kind === "qr" ? null : p));
          break;
        case "web_app_read_text_from_clipboard":
          post(source, "clipboard_text_received", {
            req_id: eventData?.req_id,
            data: null,
          });
          break;
        case "web_app_invoke_custom_method":
          post(source, "custom_method_invoked", {
            req_id: eventData?.req_id,
            error: "UNSUPPORTED_METHOD",
          });
          break;
        case "web_app_setup_main_button":
          setMainButton({
            isVisible: !!(eventData?.is_visible ?? eventData?.isVisible),
            isActive: eventData?.is_active ?? eventData?.isActive ?? true,
            text: eventData?.text,
            color: eventData?.color,
            textColor: eventData?.text_color ?? eventData?.textColor,
            isProgressVisible:
              eventData?.is_progress_visible ?? eventData?.isProgressVisible ?? false,
          });
          break;
        case "web_app_setup_secondary_button":
          setSecondaryButton({
            isVisible: !!(eventData?.is_visible ?? eventData?.isVisible),
            isActive: eventData?.is_active ?? eventData?.isActive ?? true,
            text: eventData?.text,
            color: eventData?.color,
            textColor: eventData?.text_color ?? eventData?.textColor,
          });
          break;
        case "web_app_setup_back_button":
          setBackButtonVisible(!!(eventData?.is_visible ?? eventData?.isVisible));
          break;
        case "web_app_setup_settings_button":
          setSettingsButtonVisible(!!(eventData?.is_visible ?? eventData?.isVisible));
          break;
        case "web_app_request_fullscreen":
          post(source, "fullscreen_changed", { is_fullscreen: true });
          break;
        case "web_app_exit_fullscreen":
          post(source, "fullscreen_changed", { is_fullscreen: false });
          break;
        case "web_app_request_emoji_status_access":
          post(source, "emoji_status_access_requested", { status: "cancelled" });
          break;
        case "web_app_request_file_download":
          post(source, "file_download_requested", { status: "cancelled" });
          break;
        case "web_app_send_prepared_message":
          post(source, "prepared_message_failed", { error: "UNSUPPORTED" });
          break;
        case "web_app_start_accelerometer":
        case "web_app_start_gyroscope":
        case "web_app_start_device_orientation":
          post(source, `${eventType.replace("web_app_start_", "")}_failed`, {
            error: "UNSUPPORTED",
          });
          break;
        case "web_app_check_home_screen":
          post(source, "home_screen_checked", { status: "unsupported" });
          break;
        case "web_app_biometry_get_info":
          post(source, "biometry_info_received", { available: false });
          break;
        case "web_app_setup_closing_behavior":
        case "web_app_setup_swipe_behavior":
        case "web_app_set_background_color":
        case "web_app_set_header_color":
        case "web_app_set_bottom_bar_color":
        case "web_app_trigger_haptic_feedback":
        case "web_app_data_send":
        case "web_app_switch_inline_query":
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

  return {
    popup,
    answerPopup,
    mainButton,
    secondaryButton,
    backButtonVisible,
    settingsButtonVisible,
    press,
  };
}