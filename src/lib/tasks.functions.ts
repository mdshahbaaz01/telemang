import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const createTaskSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().min(1).max(100),
  targets: z.array(z.string().min(1).max(200)).min(1).max(2000),
  minDelay: z.number().int().min(5).max(600).default(15),
  maxDelay: z.number().int().min(5).max(600).default(45),
  groupId: z.string().uuid().optional(),
});

function parseTargets(raw: string): string[] {
  return raw
    .split(/\r?\n|,|\s/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, "")
        .replace(/[?#].*$/, "")
        .replace(/^@/, ""),
    );
}
export { parseTargets };

export const createJoinTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createTaskSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: task, error } = await context.supabase
      .from("join_tasks")
      .insert({
        user_id: context.userId,
        account_id: data.accountId,
        name: data.name,
        status: "idle",
        min_delay: data.minDelay,
        max_delay: data.maxDelay,
        group_id: data.groupId ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const items = data.targets.map((t, i) => ({
      task_id: task.id,
      user_id: context.userId,
      target: t,
      position: i,
    }));
    const { error: ierr } = await context.supabase
      .from("join_task_items")
      .insert(items);
    if (ierr) throw new Error(ierr.message);
    return { taskId: task.id as string };
  });

export const getGroup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ groupId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: tasks, error } = await context.supabase
      .from("join_tasks")
      .select(
        "id, name, status, min_delay, max_delay, account_id, telegram_accounts(id, phone, username, first_name, status, paused_until)",
      )
      .eq("group_id", data.groupId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return tasks ?? [];
  });

export const listTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("join_tasks")
      .select(
        "id, name, status, created_at, account_id, telegram_accounts(phone, username)",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getTask = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: task, error } = await context.supabase
      .from("join_tasks")
      .select(
        "id, name, status, min_delay, max_delay, account_id, telegram_accounts(phone, username, status, paused_until)",
      )
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    const { data: items } = await context.supabase
      .from("join_task_items")
      .select("id, target, status, error, processed_at, position")
      .eq("task_id", data.id)
      .order("position");
    return { task, items: items ?? [] };
  });

export const setTaskStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["idle", "running", "paused", "done"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_tasks")
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const processNextJoin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ taskId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { decryptString, encryptString } = await import("./crypto.server");
    const { createTgClient } = await import("./telegram-client.server");
    const { Api } = await import("telegram");
    const { StringSession } = await import("telegram/sessions");
    const supabase = context.supabase;
    const log = async (
      taskId: string,
      level: "info" | "warn" | "error" | "success",
      message: string,
    ) => {
      await supabase
        .from("task_logs")
        .insert({ task_id: taskId, user_id: context.userId, level, message });
    };

    const { data: task, error: terr } = await supabase
      .from("join_tasks")
      .select("id, account_id, status, user_id")
      .eq("id", data.taskId)
      .single();
    if (terr || !task) throw new Error("Task not found");
    if (task.status === "paused")
      return { done: false, paused: true, message: "Task is paused" };

    const { data: acct, error: aerr } = await supabase
      .from("telegram_accounts")
      .select("id, api_id, api_hash_enc, session_enc, paused_until, phone, status")
      .eq("id", task.account_id)
      .single();
    if (aerr || !acct) throw new Error("Account not found");
    if (acct.status === "disabled") {
      return { done: false, paused: true, message: "Account disabled" };
    }
    if (acct.paused_until && new Date(acct.paused_until) > new Date()) {
      return {
        done: false,
        paused: true,
        message: `Account paused until ${acct.paused_until}`,
      };
    }
    if (!acct.session_enc) throw new Error("Account not logged in");

    const { data: item } = await supabase
      .from("join_task_items")
      .select("id, target")
      .eq("task_id", task.id)
      .eq("status", "pending")
      .order("position")
      .limit(1)
      .maybeSingle();
    if (!item) {
      await supabase
        .from("join_tasks")
        .update({ status: "done" })
        .eq("id", task.id);
      await log(task.id, "success", "All targets processed.");
      return { done: true };
    }

    const apiHash = await decryptString(acct.api_hash_enc);
    const sessionStr = await decryptString(acct.session_enc);
    const client = await createTgClient(acct.api_id, apiHash, sessionStr);
    let statusUpdate: {
      status: string;
      error: string | null;
      processed_at: string;
    } = { status: "joined", error: null, processed_at: new Date().toISOString() };

    try {
      await log(
        task.id,
        "info",
        `Joining @${item.target}…`,
      );
      try {
        const target = item.target.trim().replace(/^@/, "").replace(/[?#].*$/, "");
        const inviteHash = target.startsWith("+")
          ? target.slice(1)
          : target.toLowerCase().startsWith("joinchat/")
            ? target.slice("joinchat/".length)
            : null;

        let result: { status: "joined" | "requested"; message: string; note: string | null };

        if (inviteHash) {
          const invite = await client.invoke(
            new Api.messages.CheckChatInvite({ hash: inviteHash }),
          );
          if (invite.className === "ChatInviteAlready") {
            result = { status: "joined", message: `Already joined ${item.target}`, note: null };
          } else {
            const requestNeeded = Boolean((invite as { requestNeeded?: boolean }).requestNeeded);
            await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
            result = requestNeeded
              ? {
                  status: "requested",
                  message: `Join request sent for ${item.target}`,
                  note: "waiting for channel approval",
                }
              : { status: "joined", message: `Joined ${item.target}`, note: null };
          }
        } else {
          await client.invoke(new Api.channels.JoinChannel({ channel: target }));
          result = { status: "joined", message: `Joined @${target}`, note: null };
        }

        statusUpdate = {
          status: result.status,
          error: result.note,
          processed_at: new Date().toISOString(),
        };
        await log(
          task.id,
          "success",
          result.message,
        );
      } catch (e) {
        const err = e as { message?: string; seconds?: number };
        const msg = err.message || String(e);
        if (msg.includes("USER_ALREADY_PARTICIPANT")) {
          statusUpdate = {
            status: "joined",
            error: null,
            processed_at: new Date().toISOString(),
          };
          await log(
            task.id,
            "success",
            `Already joined @${item.target}`,
          );
        } else if (msg.includes("INVITE_REQUEST_SENT")) {
          statusUpdate = {
            status: "requested",
            error: "waiting for channel approval",
            processed_at: new Date().toISOString(),
          };
          await log(
            task.id,
            "success",
            `Join request sent for ${item.target}`,
          );
        } else if (msg.includes("FLOOD_WAIT") || err.seconds) {
          const match = msg.match(/FLOOD_WAIT_?(\d+)/i);
          const seconds = err.seconds ?? (match ? Number(match[1]) : 60);
          const pausedUntil = new Date(Date.now() + seconds * 1000).toISOString();
          await supabase
            .from("telegram_accounts")
            .update({ paused_until: pausedUntil, last_error: msg })
            .eq("id", acct.id);
          await supabase
            .from("join_tasks")
            .update({ status: "paused", updated_at: new Date().toISOString() })
            .eq("id", task.id);
          statusUpdate = {
            status: "pending",
            error: `FloodWait ${seconds}s`,
            processed_at: new Date().toISOString(),
          };
          await log(
            task.id,
            "warn",
            `FloodWait ${seconds}s — Telegram rate limited this account until ${pausedUntil}`,
          );
          return {
            done: false,
            paused: true,
            message: `FloodWait ${seconds}s`,
          };
        }
        statusUpdate = {
          status: "failed",
          error: msg,
          processed_at: new Date().toISOString(),
        };
        await log(
          task.id,
          "error",
          `Failed @${item.target}: ${msg}`,
        );
      }

      // Persist any refreshed session
      const newSession = (
        client.session as InstanceType<typeof StringSession>
      ).save();
      if (newSession && newSession !== sessionStr) {
        const enc = await encryptString(newSession);
        await supabase
          .from("telegram_accounts")
          .update({ session_enc: enc })
          .eq("id", acct.id);
      }
    } finally {
      await client.disconnect().catch(() => {});
      await supabase
        .from("join_task_items")
        .update(statusUpdate)
        .eq("id", item.id);
    }

    return { done: false, paused: false, target: item.target };
  });

export const recentLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ taskId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("task_logs")
      .select("id, level, message, created_at")
      .eq("task_id", data.taskId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// ---- Editing tasks: add/remove target items, add/remove accounts in a group ----

export const addTaskItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        taskId: z.string().uuid(),
        targets: z.array(z.string().min(1).max(200)).min(1).max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: task, error: terr } = await context.supabase
      .from("join_tasks")
      .select("id, user_id")
      .eq("id", data.taskId)
      .single();
    if (terr || !task) throw new Error("Task not found");
    const { data: last } = await context.supabase
      .from("join_task_items")
      .select("position")
      .eq("task_id", data.taskId)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const start = (last?.position ?? -1) + 1;
    const rows = data.targets.map((t, i) => ({
      task_id: data.taskId,
      user_id: task.user_id,
      target: t,
      position: start + i,
    }));
    const { error } = await context.supabase.from("join_task_items").insert(rows);
    if (error) throw new Error(error.message);
    return { added: rows.length };
  });

export const deleteTaskItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ itemId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_task_items")
      .delete()
      .eq("id", data.itemId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteJoinTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_tasks")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const addAccountsToGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        groupId: z.string().uuid(),
        accountIds: z.array(z.string().uuid()).min(1).max(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Use first existing task in the group as template
    const { data: tpl, error: terr } = await context.supabase
      .from("join_tasks")
      .select("id, name, min_delay, max_delay, account_id")
      .eq("group_id", data.groupId)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (terr) throw new Error(terr.message);
    if (!tpl) throw new Error("Group has no template task");

    // Skip accounts already in the group
    const { data: existing } = await context.supabase
      .from("join_tasks")
      .select("account_id")
      .eq("group_id", data.groupId);
    const existingIds = new Set(
      (existing ?? []).map((r: { account_id: string }) => r.account_id),
    );
    const toAdd = data.accountIds.filter((id) => !existingIds.has(id));
    if (!toAdd.length) return { added: 0, skipped: data.accountIds.length };

    // Load templates targets once
    const { data: templateItems, error: ierr } = await context.supabase
      .from("join_task_items")
      .select("target, position")
      .eq("task_id", tpl.id)
      .order("position");
    if (ierr) throw new Error(ierr.message);

    // Load account labels for naming
    const { data: accs } = await context.supabase
      .from("telegram_accounts")
      .select("id, phone, username, first_name")
      .in("id", toAdd);
    const accMap = new Map(
      (accs ?? []).map((a: {
        id: string;
        phone: string | null;
        username: string | null;
        first_name: string | null;
      }) => [a.id, a]),
    );
    const baseName = (tpl.name ?? "task").split(" · ")[0];

    let added = 0;
    for (const accountId of toAdd) {
      const acc = accMap.get(accountId);
      const label = acc?.username || acc?.first_name || acc?.phone || "acct";
      const { data: newTask, error: crErr } = await context.supabase
        .from("join_tasks")
        .insert({
          user_id: context.userId,
          account_id: accountId,
          name: `${baseName} · ${label}`,
          status: "idle",
          min_delay: tpl.min_delay,
          max_delay: tpl.max_delay,
          group_id: data.groupId,
        })
        .select("id")
        .single();
      if (crErr || !newTask) continue;
      if (templateItems?.length) {
        const rows = templateItems.map((it: { target: string; position: number }) => ({
          task_id: newTask.id,
          user_id: context.userId,
          target: it.target,
          position: it.position,
        }));
        await context.supabase.from("join_task_items").insert(rows);
      }
      added++;
    }
    return { added, skipped: data.accountIds.length - toAdd.length };
  });