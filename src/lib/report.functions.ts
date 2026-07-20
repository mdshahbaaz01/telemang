import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { openClientForAccount } from "./cleanup.server";
import { resolveTargetEntity } from "./telegram-target-resolver.server";

const REASONS = [
  "spam",
  "violence",
  "pornography",
  "childAbuse",
  "copyright",
  "geoIrrelevant",
  "fake",
  "illegalDrugs",
  "personalDetails",
  "other",
] as const;
type Reason = (typeof REASONS)[number];

function buildReason(Api: any, reason: Reason) {
  switch (reason) {
    case "spam": return new Api.InputReportReasonSpam();
    case "violence": return new Api.InputReportReasonViolence();
    case "pornography": return new Api.InputReportReasonPornography();
    case "childAbuse": return new Api.InputReportReasonChildAbuse();
    case "copyright": return new Api.InputReportReasonCopyright();
    case "geoIrrelevant": return new Api.InputReportReasonGeoIrrelevant();
    case "fake": return new Api.InputReportReasonFake();
    case "illegalDrugs": return new Api.InputReportReasonIllegalDrugs();
    case "personalDetails": return new Api.InputReportReasonPersonalDetails();
    default: return new Api.InputReportReasonOther();
  }
}

function parseMessageIdsFromTarget(target: string): number[] {
  // Support t.me/<chan>/<id> or t.me/c/<id>/<msgId>
  const m = target.match(/t\.me\/(?:c\/)?[^/]+\/(\d+)(?:\/\d+)?/i);
  if (m) return [Number(m[1])];
  return [];
}

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  if (!(data ?? []).some((r: any) => r.role === "admin")) throw new Error("Forbidden: admin only");
}

function friendly(err: unknown): string {
  const msg = String((err as any)?.errorMessage || (err as any)?.message || err);
  if (msg.includes("PEER_ID_INVALID")) return "Peer not reachable from this account";
  if (msg.includes("FLOOD_WAIT")) return msg;
  if (msg.includes("USER_BANNED_IN_CHANNEL")) return "Account banned in channel";
  if (msg.includes("CHANNEL_PRIVATE")) return "Channel private / no access";
  return msg;
}

export const bulkReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountIds: z.array(z.string().uuid()).min(1).max(200),
        targets: z.array(z.string().min(1)).min(1).max(500),
        reason: z.enum(REASONS),
        message: z.string().max(512).optional().default(""),
        // If true, report only the whole peer via account.ReportPeer.
        // If false and a message id can be parsed from the target link,
        // report specific message(s) via messages.Report.
        wholePeer: z.boolean().optional().default(true),
        // Delay (ms) between reports on the same account to avoid FloodWait.
        perAccountDelayMs: z.number().int().min(0).max(60_000).optional().default(1500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { Api } = await import("telegram/tl");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const results: Array<{
      accountId: string;
      target: string;
      ok: boolean;
      mode: "peer" | "message";
      message: string;
    }> = [];

    await Promise.all(
      data.accountIds.map(async (accountId) => {
        let client: any;
        try {
          client = await openClientForAccount(context.supabase, accountId, {
            requireOwnerId: context.userId,
          });
        } catch (e) {
          for (const t of data.targets) {
            results.push({ accountId, target: t, ok: false, mode: "peer", message: friendly(e) });
          }
          return;
        }

        for (const target of data.targets) {
          try {
            const entity = await resolveTargetEntity(client, Api, target);
            const peer = await client.getInputEntity(entity);
            const msgIds = data.wholePeer ? [] : parseMessageIdsFromTarget(target);
            const reasonObj = buildReason(Api, data.reason);

            if (msgIds.length > 0) {
              await client.invoke(
                new Api.messages.Report({
                  peer,
                  id: msgIds,
                  reason: reasonObj,
                  message: data.message || "",
                }),
              );
              results.push({ accountId, target, ok: true, mode: "message", message: `Reported msg ${msgIds.join(",")}` });
            } else {
              await client.invoke(
                new Api.account.ReportPeer({
                  peer,
                  reason: reasonObj,
                  message: data.message || "",
                }),
              );
              results.push({ accountId, target, ok: true, mode: "peer", message: "Reported peer" });
            }
          } catch (e) {
            results.push({ accountId, target, ok: false, mode: "peer", message: friendly(e) });
          }
          if (data.perAccountDelayMs > 0) await sleep(data.perAccountDelayMs);
        }

        try { await client.disconnect(); } catch { /* ignore */ }
      }),
    );

    const okCount = results.filter((r) => r.ok).length;
    return { total: results.length, ok: okCount, failed: results.length - okCount, results };
  });

export const REPORT_REASONS = REASONS;