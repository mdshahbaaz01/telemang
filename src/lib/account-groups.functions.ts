import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listAccountGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: groups, error } = await context.supabase
      .from("account_groups")
      .select("id, name, color, created_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const groupIds = (groups ?? []).map((g) => g.id as string);
    let membersByGroup = new Map<string, string[]>();
    if (groupIds.length) {
      const { data: mems } = await context.supabase
        .from("account_group_members")
        .select("group_id, account_id")
        .in("group_id", groupIds);
      for (const m of mems ?? []) {
        const arr = membersByGroup.get(m.group_id as string) ?? [];
        arr.push(m.account_id as string);
        membersByGroup.set(m.group_id as string, arr);
      }
    }
    return (groups ?? []).map((g) => ({
      id: g.id as string,
      name: g.name as string,
      color: (g.color as string | null) ?? null,
      accountIds: membersByGroup.get(g.id as string) ?? [],
    }));
  });

export const createAccountGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ name: z.string().min(1).max(60), color: z.string().max(20).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("account_groups")
      .insert({ user_id: context.userId, name: data.name, color: data.color ?? null })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

export const renameAccountGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), name: z.string().min(1).max(60), color: z.string().max(20).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("account_groups")
      .update({ name: data.name, color: data.color ?? null })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteAccountGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("account_groups").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setGroupMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ groupId: z.string().uuid(), accountIds: z.array(z.string().uuid()).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // Verify ownership of group
    const { data: g, error: gErr } = await context.supabase
      .from("account_groups")
      .select("id")
      .eq("id", data.groupId)
      .maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!g) throw new Error("Group not found");

    // Wipe and reinsert (small counts)
    const { error: delErr } = await context.supabase
      .from("account_group_members")
      .delete()
      .eq("group_id", data.groupId);
    if (delErr) throw new Error(delErr.message);

    if (data.accountIds.length) {
      const rows = data.accountIds.map((account_id) => ({ group_id: data.groupId, account_id }));
      const { error: insErr } = await context.supabase.from("account_group_members").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }
    return { ok: true, count: data.accountIds.length };
  });