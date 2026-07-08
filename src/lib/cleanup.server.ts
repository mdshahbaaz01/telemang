export async function openClientForAccount(
  supabase: any,
  accountId: string,
  opts: { requireOwnerId?: string } = {},
) {
  const { decryptString } = await import("./crypto.server");
  const { createTgClient } = await import("./telegram-client.server");
  const q = supabase
    .from("telegram_accounts")
    .select("id, user_id, api_id, api_hash_enc, session_enc, status")
    .eq("id", accountId);
  if (opts.requireOwnerId) q.eq("user_id", opts.requireOwnerId);
  const { data: acct, error } = await q.single();
  if (error || !acct) throw new Error("Account not found");
  if (acct.status === "disabled") throw new Error("Account disabled");
  if (!acct.session_enc) throw new Error("Account not logged in");
  const apiHash = await decryptString(acct.api_hash_enc);
  const sessionStr = await decryptString(acct.session_enc);
  return createTgClient(acct.api_id, apiHash, sessionStr);
}