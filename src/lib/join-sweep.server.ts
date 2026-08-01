/**
 * Post-join verification sweep + approval tracker.
 *
 * Re-checks recently joined targets (Telegram silently rolls joins back) and
 * polls pending join requests so "Requested" flips to Accepted automatically.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { openClientForAccount } from "./cleanup.server";
import { classifyJoinFailure, blockTarget, VERIFY_DELAY_MINUTES } from "./join-registry.server";

export type SweepSummary = {
  checked: number;
  confirmed: number;
  dropped: number;
  accepted: number;
  stillPending: number;
  banned: number;
  errors: number;
};

const MAX_CHECKS = 8;

function keyToTarget(targetKey: string): string | null {
  if (targetKey.startsWith("user:")) return targetKey.slice(5);
  if (targetKey.startsWith("invite:")) return `+${targetKey.slice(7)}`;
  if (targetKey.startsWith("id:")) return targetKey.slice(3);
  return null;
}

async function isMember(client: any, Api: any, chatId: string | null, targetKey: string): Promise<boolean | null> {
  const target = keyToTarget(targetKey);
  try {
    let entity: any = null;
    if (target && !target.startsWith("+")) {
      entity = await client.getEntity(target);
    } else if (chatId) {
      entity = await client.getEntity(BigInt(chatId) as any);
    } else {
      return null; // invite-only with no resolved id — cannot re-check cheaply
    }
    if (entity?.left === true) return false;
    if (entity?.left === false || entity?.creator) return true;
    const me = await client.getMe(true);
    const input = await client.getInputEntity(entity);
    await client.invoke(new Api.channels.GetParticipant({ channel: input, participant: me }));
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/USER_NOT_PARTICIPANT|CHANNEL_PRIVATE|PARTICIPANT_ID_INVALID/i.test(msg)) return false;
    if (/Cannot cast InputPeerChat/i.test(msg)) return null; // legacy group: trust prior state
    return null;
  }
}

export async function runJoinVerifySweep(
  supabase: SupabaseClient<any>,
  opts: { userId?: string; limit?: number } = {},
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    checked: 0, confirmed: 0, dropped: 0, accepted: 0, stillPending: 0, banned: 0, errors: 0,
  };

  let query = supabase
    .from("join_memberships")
    .select("id, user_id, account_id, target_key, chat_id, status, checks")
    .in("status", ["joined", "requested", "dropped"])
    .lte("verify_after", new Date().toISOString())
    .lt("checks", MAX_CHECKS)
    .order("verify_after", { ascending: true })
    .limit(opts.limit ?? 60);
  if (opts.userId) query = query.eq("user_id", opts.userId);

  const { data: rows, error } = await query;
  if (error || !rows?.length) return summary;

  const byAccount = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.account_id) continue;
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }

  const { Api } = await import("telegram");

  for (const [accountId, list] of byAccount) {
    let client: any = null;
    try {
      client = await openClientForAccount(supabase, accountId);
      await client.connect();
    } catch {
      summary.errors += list.length;
      continue;
    }
    try {
      for (const row of list) {
        summary.checked++;
        const member = await isMember(client, Api, row.chat_id, row.target_key);
        const nextChecks = (row.checks ?? 0) + 1;
        const backoffMinutes = VERIFY_DELAY_MINUTES * Math.pow(2, Math.min(nextChecks, 5));
        let status = row.status as string;
        let verifiedAt: string | null = null;
        let verifyAfter: string | null = new Date(Date.now() + backoffMinutes * 60_000).toISOString();

        if (member === true) {
          status = row.status === "requested" ? "accepted" : "joined";
          verifiedAt = new Date().toISOString();
          verifyAfter = null;
          if (row.status === "requested") summary.accepted++;
          else summary.confirmed++;
        } else if (member === false) {
          if (row.status === "requested") {
            summary.stillPending++;
          } else {
            status = "dropped";
            summary.dropped++;
          }
        } else {
          summary.errors++;
        }

        await supabase
          .from("join_memberships")
          .update({ status, checks: nextChecks, verified_at: verifiedAt, verify_after: verifyAfter, last_check_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }

  return summary;
}

/** Mark a pair permanently blocked from a caught Telegram error string. */
export async function blockIfPermanent(
  supabase: SupabaseClient<any>,
  userId: string,
  accountId: string,
  targetKey: string,
  message: string,
): Promise<boolean> {
  const verdict = classifyJoinFailure(message);
  if (!verdict.permanent) return false;
  await blockTarget({ supabase, userId, accountId }, targetKey, verdict.reason, verdict.code);
  return true;
}