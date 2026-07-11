# Broadcast to users by user ID

## Short answer
Partially yes. Telegram itself does **not** let you DM an arbitrary numeric user ID out of nowhere — every send needs an `access_hash` for that user. That hash only exists on your account if it has "seen" the user before (mutual group/channel, contact, forwarded message, previous DM, or a resolved username at least once).

So the rule is:
- **User has interacted with that account before** (any of the above) → we can send using just the numeric ID.
- **Never interacted** → Telegram returns `PEER_ID_INVALID` / `Could not find the input entity`. No client can bypass this; even official Telegram won't let you type a random ID and message it.

## What I'll change in the app

### 1. Accept numeric IDs in target inputs
Currently `resolveTargetEntity` (`src/lib/broadcast-executor.server.ts`) and the actions-stream target parser only handle `@username`, `t.me/...`, `c/<id>`, and invite links. I'll extend both to accept:
- Pure numeric: `123456789` → treat as user ID
- Prefixed: `user:123456789`, `id:123456789` → explicit user
- Chat/channel numeric IDs (`-100...` or `c/...` already handled)

### 2. Resolution strategy per account
For each numeric user ID:
1. Try `client.getInputEntity(Number(id))` — hits the local entity cache.
2. On miss, prime the cache: `client.getDialogs({ limit: 500 })` (same trick already used in `resolvePeerFromKey`), then retry.
3. Still miss → throw a clear, human-readable error: `User 123456789 not reachable from account @X (no prior interaction — Telegram needs an access_hash).`

That error will show up per row in the logs so the user knows exactly which account/target combination failed and why, instead of the generic 400.

### 3. TargetsPicker UI hint
Add a small helper line under the targets textarea in Broadcast / Reply / Forwarder / Bulk delete:
"You can paste `@username`, `t.me/...` link, invite link, or a numeric user ID (`123456789`). Numeric IDs only work from accounts that have interacted with that user before."

### 4. Optional: contacts import fallback
If the user turns on a new "Try importing contact for unknown IDs" toggle, before failing we call `contacts.ImportContacts` with the numeric ID and a placeholder name. This sometimes lets Telegram return an access_hash. Off by default because it writes to the account's contacts.

## Files touched
- `src/lib/broadcast-executor.server.ts` — extend `resolveTargetEntity` with numeric-ID branch + dialog prime + friendly error.
- `src/routes/api/public/actions-stream.ts` — same extension for the streaming path (broadcast / reply / forward / delete).
- `src/routes/_authenticated/actions.tsx` — helper hint text under targets fields; no behavior change.
- (Optional) new checkbox `importUnknownContacts` wired through the payload if you want the contacts fallback.

## Not doing
- No attempt to bypass `access_hash` — impossible on Telegram's protocol.
- No change to Bulk Mix / view boosts (they need message links, not users).

## Confirm before I build
1. Include the optional "import contact" fallback toggle, or skip it?
2. Should numeric IDs also be accepted as **forward destinations** and **reply targets**, or only in broadcast?
