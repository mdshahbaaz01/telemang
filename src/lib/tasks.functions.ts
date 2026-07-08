import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const delaySchema = z.coerce.number().int().min(0).max(3600);

const createTaskSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().min(1).max(100),
  targets: z.array(z.string().min(1).max(200)).min(1).max(2000),
  minDelay: delaySchema.default(15),
  maxDelay: delaySchema.default(45),
  groupId: z.string().uuid().optional(),
});

function parseTargets(raw: string): string[] {
  return raw
    .split(/\r?\n|,|\s/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/^@/, "")
        .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
        .replace(/[?#].*$/, "")
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

export const listTaskGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: tasks, error } = await context.supabase
      .from("join_tasks")
      .select("id, group_id, name, status, min_delay, max_delay, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    type Agg = {
      groupId: string;
      name: string;
      minDelay: number;
      maxDelay: number;
      createdAt: string;
      taskIds: string[];
      statuses: string[];
    };
    const groups = new Map<string, Agg>();
    for (const t of tasks ?? []) {
      const gid = t.group_id ?? t.id;
      const baseName = (t.name ?? "task").split(" · ")[0];
      const g = groups.get(gid);
      if (!g) {
        groups.set(gid, {
          groupId: gid,
          name: baseName,
          minDelay: t.min_delay,
          maxDelay: t.max_delay,
          createdAt: t.created_at,
          taskIds: [t.id],
          statuses: [t.status],
        });
      } else {
        g.taskIds.push(t.id);
        g.statuses.push(t.status);
        if (t.created_at > g.createdAt) g.createdAt = t.created_at;
      }
    }

    const results: Array<{
      groupId: string;
      name: string;
      minDelay: number;
      maxDelay: number;
      createdAt: string;
      accounts: number;
      total: number;
      done: number;
      failed: number;
      pending: number;
      running: boolean;
      status: "running" | "done" | "failed" | "idle" | "partial";
    }> = [];
    for (const g of groups.values()) {
      const { data: items } = await context.supabase
        .from("join_task_items")
        .select("status")
        .in("task_id", g.taskIds);
      const list = items ?? [];
      const total = list.length;
      const done = list.filter(
        (i) => i.status === "joined" || i.status === "requested",
      ).length;
      const failed = list.filter((i) => i.status === "failed").length;
      const pending = list.filter((i) => i.status === "pending").length;
      const running = g.statuses.includes("running");
      const status: "running" | "done" | "failed" | "idle" | "partial" = running
        ? "running"
        : total > 0 && done + failed === total
          ? failed === 0
            ? "done"
            : done === 0
              ? "failed"
              : "partial"
          : "idle";
      results.push({
        groupId: g.groupId,
        name: g.name,
        minDelay: g.minDelay,
        maxDelay: g.maxDelay,
        createdAt: g.createdAt,
        accounts: g.taskIds.length,
        total,
        done,
        failed,
        pending,
        running,
        status,
      });
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

export const getGroupEdit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ groupId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: tasks, error } = await context.supabase
      .from("join_tasks")
      .select("id, name, min_delay, max_delay, account_id")
      .eq("group_id", data.groupId);
    if (error) throw new Error(error.message);
    if (!tasks?.length) throw new Error("Group not found");
    const first = tasks[0];
    const baseName = (first.name ?? "task").split(" · ")[0];
    const { data: items } = await context.supabase
      .from("join_task_items")
      .select("target")
      .in("task_id", tasks.map((t) => t.id));
    const targets = Array.from(new Set((items ?? []).map((i) => i.target)));
    return {
      groupId: data.groupId,
      name: baseName,
      minDelay: first.min_delay as number,
      maxDelay: first.max_delay as number,
      targets,
      accountIds: tasks.map((t) => t.account_id as string),
    };
  });

export const updateGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        groupId: z.string().uuid(),
        name: z.string().min(1).max(100),
        minDelay: delaySchema,
        maxDelay: delaySchema,
        targets: z.array(z.string().min(1).max(200)).max(2000),
        accountIds: z.array(z.string().uuid()).max(100),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: tasks, error } = await context.supabase
      .from("join_tasks")
      .select("id, account_id")
      .eq("group_id", data.groupId);
    if (error) throw new Error(error.message);
    if (!tasks?.length) throw new Error("Group not found");

    const existingByAccount = new Map<string, string>(
      tasks.map((t) => [t.account_id as string, t.id as string]),
    );
    const keep = new Set(data.accountIds);

    // Remove tasks for deselected accounts
    const toRemove = tasks
      .filter((t) => !keep.has(t.account_id as string))
      .map((t) => t.id as string);
    if (toRemove.length) {
      await context.supabase.from("join_tasks").delete().in("id", toRemove);
    }

    // Load account labels for renaming / naming
    const { data: accs } = await context.supabase
      .from("telegram_accounts")
      .select("id, phone, username, first_name")
      .in("id", data.accountIds.length ? data.accountIds : ["00000000-0000-0000-0000-000000000000"]);
    const accMap = new Map(
      (accs ?? []).map((a: {
        id: string; phone: string | null; username: string | null; first_name: string | null;
      }) => [a.id, a]),
    );
    const buildName = (accId: string) => {
      const a = accMap.get(accId);
      const label = a?.username || a?.first_name || a?.phone || "acct";
      return data.accountIds.length > 1 ? `${data.name} · ${label}` : data.name;
    };

    const newTargets = new Set(data.targets);
    const remainingTaskIds: string[] = [];

    // Update kept tasks
    for (const [accId, tid] of existingByAccount) {
      if (!keep.has(accId)) continue;
      remainingTaskIds.push(tid);
      await context.supabase
        .from("join_tasks")
        .update({
          name: buildName(accId),
          min_delay: data.minDelay,
          max_delay: data.maxDelay,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tid);

      const { data: existingItems } = await context.supabase
        .from("join_task_items")
        .select("id, target, position")
        .eq("task_id", tid);
      const existingSet = new Set(
        (existingItems ?? []).map((i: { target: string }) => i.target),
      );
      const toDel = (existingItems ?? [])
        .filter((i: { target: string }) => !newTargets.has(i.target))
        .map((i: { id: string }) => i.id);
      if (toDel.length) {
        await context.supabase.from("join_task_items").delete().in("id", toDel);
      }
      const positions = (existingItems ?? []).map(
        (i: { position: number }) => i.position,
      );
      const posStart = (positions.length ? Math.max(...positions) : -1) + 1;
      const toAdd = data.targets
        .filter((t) => !existingSet.has(t))
        .map((t, i) => ({
          task_id: tid,
          user_id: context.userId,
          target: t,
          position: posStart + i,
        }));
      if (toAdd.length) {
        await context.supabase.from("join_task_items").insert(toAdd);
      }
    }

    // Add new accounts
    const toAddAcc = data.accountIds.filter(
      (id) => !existingByAccount.has(id),
    );
    for (const accId of toAddAcc) {
      const { data: newTask, error: cErr } = await context.supabase
        .from("join_tasks")
        .insert({
          user_id: context.userId,
          account_id: accId,
          name: buildName(accId),
          status: "idle",
          min_delay: data.minDelay,
          max_delay: data.maxDelay,
          group_id: data.groupId,
        })
        .select("id")
        .single();
      if (cErr || !newTask) continue;
      if (data.targets.length) {
        const rows = data.targets.map((t, i) => ({
          task_id: newTask.id,
          user_id: context.userId,
          target: t,
          position: i,
        }));
        await context.supabase.from("join_task_items").insert(rows);
      }
    }

    return { ok: true };
  });

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ groupId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("join_tasks")
      .delete()
      .eq("group_id", data.groupId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const resetGroupItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        groupId: z.string().uuid(),
        scope: z.enum(["failed", "all"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: tasks } = await context.supabase
      .from("join_tasks")
      .select("id")
      .eq("group_id", data.groupId);
    const ids = (tasks ?? []).map((t) => t.id as string);
    if (!ids.length) return { reset: 0 };
    let q = context.supabase
      .from("join_task_items")
      .update({ status: "pending", error: null, processed_at: null })
      .in("task_id", ids);
    if (data.scope === "failed") q = q.eq("status", "failed");
    const { data: updated, error } = await q.select("id");
    if (error) throw new Error(error.message);
    await context.supabase
      .from("join_tasks")
      .update({ status: "idle", updated_at: new Date().toISOString() })
      .in("id", ids);
    return { reset: updated?.length ?? 0 };
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
        const target = item.target
          .trim()
          .replace(/^@/, "")
          .replace(/[?#].*$/, "")
          .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
          .replace(/^@/, "");
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
        } else if (
          msg.includes("INVITE_REQUEST_SENT") ||
          msg.includes("INVITE_REQUEST_ALREADY_SENT") ||
          msg.includes("REQUEST_SENT")
        ) {
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
        } else {
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

// Batch processor: join multiple targets in parallel using one Telegram client.
export const processBatchJoin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        taskId: z.string().uuid(),
        batchSize: z.coerce.number().int().min(1).max(10).default(5),
      })
      .parse(d),
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
      return { done: false, paused: true, processed: 0, message: "Task is paused" };

    const { data: acct, error: aerr } = await supabase
      .from("telegram_accounts")
      .select("id, api_id, api_hash_enc, session_enc, paused_until, phone, status")
      .eq("id", task.account_id)
      .single();
    if (aerr || !acct) throw new Error("Account not found");
    if (acct.status === "disabled")
      return { done: false, paused: true, processed: 0, message: "Account disabled" };
    if (acct.paused_until && new Date(acct.paused_until) > new Date())
      return {
        done: false,
        paused: true,
        processed: 0,
        message: `Account paused until ${acct.paused_until}`,
      };
    if (!acct.session_enc) throw new Error("Account not logged in");

    const { data: items } = await supabase
      .from("join_task_items")
      .select("id, target")
      .eq("task_id", task.id)
      .eq("status", "pending")
      .order("position")
      .limit(data.batchSize);

    if (!items || items.length === 0) {
      await supabase.from("join_tasks").update({ status: "done" }).eq("id", task.id);
      await log(task.id, "success", "All targets processed.");
      return { done: true, paused: false, processed: 0 };
    }

    const apiHash = await decryptString(acct.api_hash_enc);
    const sessionStr = await decryptString(acct.session_enc);
    const client = await createTgClient(acct.api_id, apiHash, sessionStr);

    let floodPaused: { seconds: number } | null = null;

    const processOne = async (item: { id: string; target: string }) => {
      let statusUpdate: {
        status: string;
        error: string | null;
        processed_at: string;
      } = { status: "joined", error: null, processed_at: new Date().toISOString() };
      try {
        await log(task.id, "info", `Joining @${item.target}…`);
        const target = item.target
          .trim()
          .replace(/^@/, "")
          .replace(/[?#].*$/, "")
          .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
          .replace(/^@/, "");
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
        await log(task.id, "success", result.message);
      } catch (e) {
        const err = e as { message?: string; seconds?: number };
        const msg = err.message || String(e);
        if (msg.includes("USER_ALREADY_PARTICIPANT")) {
          statusUpdate = {
            status: "joined",
            error: null,
            processed_at: new Date().toISOString(),
          };
          await log(task.id, "success", `Already joined @${item.target}`);
        } else if (
          msg.includes("INVITE_REQUEST_SENT") ||
          msg.includes("INVITE_REQUEST_ALREADY_SENT") ||
          msg.includes("REQUEST_SENT")
        ) {
          statusUpdate = {
            status: "requested",
            error: "waiting for channel approval",
            processed_at: new Date().toISOString(),
          };
          await log(task.id, "success", `Join request sent for ${item.target}`);
        } else if (msg.includes("FLOOD_WAIT") || err.seconds) {
          const match = msg.match(/FLOOD_WAIT_?(\d+)/i);
          const seconds = err.seconds ?? (match ? Number(match[1]) : 60);
          floodPaused = { seconds };
          statusUpdate = {
            status: "pending",
            error: `FloodWait ${seconds}s`,
            processed_at: new Date().toISOString(),
          };
          await log(
            task.id,
            "warn",
            `FloodWait ${seconds}s — Telegram rate limited this account`,
          );
        } else {
          statusUpdate = {
            status: "failed",
            error: msg,
            processed_at: new Date().toISOString(),
          };
          await log(task.id, "error", `Failed @${item.target}: ${msg}`);
        }
      }
      await supabase.from("join_task_items").update(statusUpdate).eq("id", item.id);
    };

    try {
      await Promise.all(items.map(processOne));
      const newSession = (client.session as InstanceType<typeof StringSession>).save();
      if (newSession && newSession !== sessionStr) {
        const enc = await encryptString(newSession);
        await supabase
          .from("telegram_accounts")
          .update({ session_enc: enc })
          .eq("id", acct.id);
      }
    } finally {
      await client.disconnect().catch(() => {});
    }

    if (floodPaused) {
      const pausedUntil = new Date(Date.now() + floodPaused.seconds * 1000).toISOString();
      await supabase
        .from("telegram_accounts")
        .update({ paused_until: pausedUntil, last_error: `FloodWait ${floodPaused.seconds}s` })
        .eq("id", acct.id);
      await supabase
        .from("join_tasks")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", task.id);
      return {
        done: false,
        paused: true,
        processed: items.length,
        message: `FloodWait ${floodPaused.seconds}s`,
      };
    }

    return { done: false, paused: false, processed: items.length };
  });

const _recentLogs_marker = createServerFn({ method: "GET" })
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

export const groupLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ groupId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: tasks } = await context.supabase
      .from("join_tasks")
      .select("id, name")
      .eq("group_id", data.groupId);
    const ids = (tasks ?? []).map((t) => t.id as string);
    if (!ids.length) return [];
    const labelMap = new Map(
      (tasks ?? []).map((t) => [
        t.id as string,
        ((t.name ?? "").split(" · ")[1] ?? "").trim(),
      ]),
    );
    const { data: rows, error } = await context.supabase
      .from("task_logs")
      .select("id, task_id, level, message, created_at")
      .in("task_id", ids)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => ({
      ...r,
      account: labelMap.get(r.task_id as string) ?? "",
    }));
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