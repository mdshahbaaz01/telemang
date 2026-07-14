import { supabase } from "@/integrations/supabase/client";
import { CLIENT_SESSION_KEY_STORAGE, registerSession, heartbeatSession } from "@/lib/sessions.functions";

let started = false;
let timer: number | undefined;

function getKey(): string {
  if (typeof window === "undefined") return "";
  let k = window.localStorage.getItem(CLIENT_SESSION_KEY_STORAGE);
  if (!k) {
    k = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    window.localStorage.setItem(CLIENT_SESSION_KEY_STORAGE, k);
  }
  return k;
}

export function getCurrentSessionKey(): string {
  return getKey();
}

async function tick() {
  try {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    const key = getKey();
    const res = await heartbeatSession({ data: { sessionKey: key } });
    if (res.revoked) {
      await supabase.auth.signOut();
      window.location.href = "/auth";
    }
  } catch {
    // swallow — offline etc.
  }
}

export function startSessionHeartbeat() {
  if (started || typeof window === "undefined") return;
  started = true;
  (async () => {
    try {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      const key = getKey();
      await registerSession({
        data: { sessionKey: key, userAgent: navigator.userAgent.slice(0, 500) },
      }).catch(() => {});
    } catch {}
  })();
  timer = window.setInterval(tick, 5 * 60 * 1000);
  window.addEventListener("focus", tick);
}

export function stopSessionHeartbeat() {
  if (timer) window.clearInterval(timer);
  started = false;
}