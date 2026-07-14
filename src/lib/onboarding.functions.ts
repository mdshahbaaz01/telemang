import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type OnboardingState = {
  steps: {
    id: string;
    title: string;
    done: boolean;
    href?: string;
    hint?: string;
  }[];
  dismissed: boolean;
  progress: number; // 0..1
  completed: number;
  total: number;
};

export const getOnboardingState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OnboardingState> => {
    const uid = context.userId;
    const [accts, settings, bcasts, tasks, favs, presets] = await Promise.all([
      context.supabase.from("telegram_accounts").select("id", { count: "exact", head: true }).eq("user_id", uid),
      context.supabase.from("user_admin_settings").select("account_add_approved, onboarding_state").eq("user_id", uid).maybeSingle(),
      context.supabase.from("scheduled_broadcasts").select("id", { count: "exact", head: true }).eq("user_id", uid),
      context.supabase.from("join_tasks").select("id", { count: "exact", head: true }).eq("user_id", uid),
      context.supabase.from("user_favorites").select("id", { count: "exact", head: true }).eq("user_id", uid),
      context.supabase.from("action_presets").select("id", { count: "exact", head: true }).eq("user_id", uid),
    ]);
    const dismissed = !!(settings.data as any)?.onboarding_state?.dismissed;
    const approved = !!(settings.data as any)?.account_add_approved;
    const steps = [
      {
        id: "request",
        title: "Get approved to add accounts",
        done: approved,
        href: "/dashboard",
        hint: "Ask the owner from your dashboard.",
      },
      {
        id: "connect",
        title: "Connect your first Telegram account",
        done: (accts.count ?? 0) > 0,
        href: "/dashboard",
        hint: "Phone, api_id, api_hash from my.telegram.org.",
      },
      {
        id: "broadcast",
        title: "Send your first broadcast",
        done: (bcasts.count ?? 0) > 0,
        href: "/actions?tab=broadcast",
        hint: "Try a short message to one chat first.",
      },
      {
        id: "task",
        title: "Create your first task",
        done: (tasks.count ?? 0) > 0,
        href: "/tasks/new",
        hint: "Join, react, forward, or comment in bulk.",
      },
      {
        id: "polish",
        title: "Save a favorite or preset",
        done: (favs.count ?? 0) + (presets.count ?? 0) > 0,
        href: "/search",
        hint: "Speeds up your repeat runs.",
      },
    ];
    const completed = steps.filter((s) => s.done).length;
    return {
      steps,
      dismissed,
      progress: steps.length ? completed / steps.length : 0,
      completed,
      total: steps.length,
    };
  });

export const setOnboardingDismissed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ dismissed: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: cur } = await context.supabase
      .from("user_admin_settings")
      .select("onboarding_state")
      .eq("user_id", context.userId)
      .maybeSingle();
    const state = { ...((cur as any)?.onboarding_state ?? {}), dismissed: data.dismissed };
    const { error } = await context.supabase
      .from("user_admin_settings")
      .upsert(
        { user_id: context.userId, onboarding_state: state },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });