import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type AlertEvent = "success" | "failure" | "account";

async function insertLog(
  supabase: SupabaseClient<Database>,
  userId: string,
  channel: string,
  event: AlertEvent,
  title: string,
  body: string,
  status = "logged",
  error: string | null = null,
) {
  await supabase
    .from("notification_logs")
    .insert({ user_id: userId, channel, event, title, body, status, error })
    .then(() => undefined, () => undefined);
}

async function sendTelegramAlert(supabase: SupabaseClient<Database>, userId: string, target: string, text: string) {
  const { data: acct, error } = await supabase
    .from("telegram_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!acct?.id) throw new Error("No active Telegram account available for alerts");
  const { openClientForAccount } = await import("./cleanup.server");
  const client = await openClientForAccount(supabase, acct.id);
  try {
    const peer = await client.getEntity(target.replace(/^@/, ""));
    await client.sendMessage(peer, { message: text });
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function sendEmailAlert(to: string, subject: string, body: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Email provider is not configured");
  const from = process.env.ALERT_FROM_EMAIL || "alerts@lovable.app";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to, subject, text: body }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function notifyUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  event: AlertEvent,
  title: string,
  body: string,
) {
  const { data: settings } = await supabase
    .from("notification_settings")
    .select("email_enabled, telegram_enabled, email_to, telegram_chat, alert_success, alert_failure, alert_account")
    .eq("user_id", userId)
    .maybeSingle();
  const enabled = event === "success" ? settings?.alert_success : event === "failure" ? settings?.alert_failure : settings?.alert_account;
  await insertLog(supabase, userId, "app", event, title, body);
  if (!settings || enabled === false) return;

  if (settings.telegram_enabled && settings.telegram_chat) {
    try {
      await sendTelegramAlert(supabase, userId, settings.telegram_chat, `${title}\n${body}`);
      await insertLog(supabase, userId, "telegram", event, title, body, "sent");
    } catch (e) {
      await insertLog(supabase, userId, "telegram", event, title, body, "failed", (e as Error).message);
    }
  }

  if (settings.email_enabled && settings.email_to) {
    try {
      await sendEmailAlert(settings.email_to, title, body);
      await insertLog(supabase, userId, "email", event, title, body, "sent");
    } catch (e) {
      await insertLog(supabase, userId, "email", event, title, body, "failed", (e as Error).message);
    }
  }
}

export type OwnerAlertKind = "ban" | "peer_flood" | "job_failure" | "daily_summary";

export async function notifyOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  kind: OwnerAlertKind,
  title: string,
  body: string,
) {
  const { data: settings } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  const s = settings as any;
  const gate =
    kind === "ban" ? s?.alert_on_ban :
    kind === "peer_flood" ? s?.alert_on_peer_flood :
    kind === "job_failure" ? s?.alert_on_job_failure :
    true;
  const event: AlertEvent = kind === "job_failure" ? "failure" : "account";
  await insertLog(supabase, userId, "app", event, title, body);
  if (!settings || gate === false) return;
  if (s.telegram_enabled && s.telegram_chat) {
    try {
      await sendTelegramAlert(supabase, userId, s.telegram_chat, `${title}\n${body}`);
      await insertLog(supabase, userId, "telegram", event, title, body, "sent");
    } catch (e) {
      await insertLog(supabase, userId, "telegram", event, title, body, "failed", (e as Error).message);
    }
  }
  if (s.email_enabled && s.email_to) {
    try {
      await sendEmailAlert(s.email_to, title, body);
      await insertLog(supabase, userId, "email", event, title, body, "sent");
    } catch (e) {
      await insertLog(supabase, userId, "email", event, title, body, "failed", (e as Error).message);
    }
  }
}