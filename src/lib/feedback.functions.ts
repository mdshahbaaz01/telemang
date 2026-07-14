import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type FeatureRequestRow = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  category: "feature" | "bug" | "improvement";
  status: "open" | "planned" | "in_progress" | "done" | "declined";
  priority: "low" | "med" | "high";
  owner_note: string | null;
  votes_count: number;
  created_at: string;
  updated_at: string;
  email?: string;
  voted?: boolean;
  mine?: boolean;
};

export const listFeatureRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("feature_requests")
      .select("*")
      .order("votes_count", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as FeatureRequestRow[];
    const ids = rows.map((r) => r.id);
    let voted = new Set<string>();
    if (ids.length) {
      const { data: vs } = await context.supabase
        .from("feature_request_votes")
        .select("request_id")
        .eq("user_id", context.userId)
        .in("request_id", ids);
      voted = new Set((vs ?? []).map((v: any) => v.request_id));
    }
    // Emails via admin listUsers (owner tab needs them)
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const emails = new Map<string, string>();
    for (const u of list?.users ?? []) if (u.email) emails.set(u.id, u.email);
    return rows.map((r) => ({
      ...r,
      email: emails.get(r.user_id) ?? "",
      voted: voted.has(r.id),
      mine: r.user_id === context.userId,
    }));
  });

export const createFeatureRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      title: z.string().min(3).max(140),
      description: z.string().max(4000).optional(),
      category: z.enum(["feature", "bug", "improvement"]).default("feature"),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("feature_requests")
      .insert({
        user_id: context.userId,
        title: data.title.trim(),
        description: data.description?.trim() || null,
        category: data.category,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const toggleVoteFeatureRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), vote: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.vote) {
      const { error } = await context.supabase
        .from("feature_request_votes")
        .insert({ request_id: data.id, user_id: context.userId });
      if (error && !error.message.includes("duplicate")) throw new Error(error.message);
    } else {
      const { error } = await context.supabase
        .from("feature_request_votes")
        .delete()
        .eq("request_id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const deleteFeatureRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("feature_requests")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const ownerUpdateFeatureRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      status: z.enum(["open", "planned", "in_progress", "done", "declined"]).optional(),
      priority: z.enum(["low", "med", "high"]).optional(),
      owner_note: z.string().max(1000).nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: {
      status?: FeatureRequestRow["status"];
      priority?: FeatureRequestRow["priority"];
      owner_note?: string | null;
    } = {};
    if (data.status !== undefined) patch.status = data.status;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (data.owner_note !== undefined) patch.owner_note = data.owner_note;
    if (!Object.keys(patch).length) return { ok: true };
    const { error } = await context.supabase
      .from("feature_requests")
      .update(patch)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });