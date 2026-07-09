# Broadcast Replies Viewer with Inline Button Clicks

Add a new "Replies" panel to the Broadcast tab that opens after a broadcast completes (or on demand for any past run). It shows the bot/chat's replies to each `(account × target)` pair, and if any reply carries an inline keyboard, renders each button so the user can click it — the click is executed by that same account via GramJS.

## User flow

1. User sends a broadcast as usual.
2. When the run finishes, a new **"View Replies"** button appears on that row in the Run History panel — and a full **Replies** section auto-opens below the broadcast form for the just-completed run.
3. The Replies view lists one collapsible card per `account × target`. Each card shows:
   - Account name + target chat chip
   - The most recent 5 messages received in that chat since the broadcast was sent (day separators, sender name, timestamp)
   - Under any message with a `replyInlineMarkup`, the button grid rendered as clickable chips
4. Clicking an **inline button**:
   - **Callback** → server call presses it via `messages.getBotCallbackAnswer`; the bot's popup/toast text is shown as a toast; new reply lines refresh automatically.
   - **URL / login URL** → opens in a new tab (`rel="noopener noreferrer"`) after a small confirm dialog showing the full URL.
   - **WebApp / switch_inline / other** → disabled chip with tooltip explaining it's unsupported from a user account.
5. Card auto-refreshes every 4 s while open; manual refresh button too. "Refresh all" at the top of the panel.

## UI additions

`src/routes/_authenticated/actions.tsx` (broadcast tab):

- New `<BroadcastRepliesPanel runId={…} />` component. Rendered:
  - Automatically when a live broadcast finishes (from the SSE `done` event).
  - From a "View Replies" button on each row of the existing Run History list (opens in a Dialog).
- Panel state: list of `{accountId, target, messages[], lastSeenId}` derived from a new server fn.

New small components (co-located in the same file or `src/components/broadcast/`):
- `ReplyCard` — one account×target card
- `InlineKeyboard` — renders the button grid, dispatches clicks
- `MessageBubble` — reused/adapted from the chat viewer bubble

## New server functions (`src/lib/broadcast-replies.functions.ts`)

All protected by `requireSupabaseAuth` + account-ownership check (`account.user_id === userId`, or admin).

1. **`getBroadcastReplies({ runId })`** — reads `action_runs.params` for the just-run broadcast, expands the `(accountId, target)` pairs, then for each pair:
   - Opens a GramJS client for the account (via existing `openClientForAccount`)
   - Calls `messages.getHistory(peer=target, limit=6, minId=<msgId sent by our broadcast if known, else 0>)`
   - Returns a serialized list per pair: `{ accountId, target, messages: [{id, senderId, senderName, date, text, media?, replyMarkup?}], lastId }`
   - `replyMarkup` is flattened to `{ rows: [[ { kind: 'callback'|'url'|'webapp'|'other', text, data?, url? } ] ] }` — raw `Buffer` data base64-encoded for callback buttons.
   - All account fetches run in parallel with a per-run concurrency cap of 5.

2. **`pressInlineButton({ accountId, target, msgId, data })`** — clicks a callback button. Runs `messages.getBotCallbackAnswer({ peer, msgId, data: Buffer.from(data,'base64') })`. Returns `{ message?: string, alert?: boolean }` (the bot's popup text). On `BUTTON_DATA_INVALID`/`MESSAGE_ID_INVALID`, returns a clean error the UI shows as a toast.

3. **`refreshReplyThread({ accountId, target, sinceId })`** — same as `getBroadcastReplies` but for a single pair; used by auto-refresh.

Notes:
- All three run through the same FloodWait-aware wrapper used by broadcast execution: on `FLOOD_WAIT_(\d+)` pause the account, surface the wait to the UI.
- Nothing new is stored server-side — the panel is derived state pulled fresh from Telegram. This avoids schema growth and keeps the panel accurate even if messages get edited/deleted.

## Where the "sent message id" comes from

Currently `executeBroadcast` doesn't persist the returned message id per target. Small addition: in `src/lib/broadcast-executor.server.ts` and the broadcast branch of `src/routes/api/public/actions-stream.ts`, when a send succeeds, include `{ target, accountId, msgId }` in the `action_logs.message` payload (or extend `action_runs.totals` with a `sent: [{account, target, msgId}]` array).

This lets `getBroadcastReplies` fetch only messages *after* our own send, so the panel shows the actual replies — not the original text and prior chat history.

## Security & guardrails

- Every server fn checks `requireSupabaseAuth` and re-verifies `telegram_accounts.user_id = userId` before touching GramJS.
- URL buttons never opened server-side (would leak the server IP). Client-side open with confirmation.
- Callback `data` is treated as opaque bytes; input validated by zod (base64 string, ≤512 bytes).
- Rate limit: at most one manual "Refresh all" per 4 s; auto-poll every 4 s per open card, paused when tab is hidden.

## Scope boundaries

**In scope:**
- View replies to broadcasts (only, for now — not to reply/comment/forward runs)
- Click callback + open URL buttons
- Auto-refresh, manual refresh, toast for callback response

**Out of scope (potential follow-ups):**
- Replying inline from this panel (already exists in `/accounts/:id`)
- Persistent history of replies (currently pulled live each open)
- WebApp buttons (require Telegram desktop/mobile client)
- Reply threads for the Reply/Comment/Forward tabs — easy follow-up once this works

## Files touched

- `src/routes/_authenticated/actions.tsx` — new Replies panel + Run History "View Replies" button
- `src/lib/broadcast-replies.functions.ts` — three new server fns (new file)
- `src/lib/broadcast-executor.server.ts` — record sent msg id per target
- `src/routes/api/public/actions-stream.ts` — same recording in the SSE broadcast branch
- (optional) `src/components/broadcast/InlineKeyboard.tsx`, `ReplyCard.tsx`

## Verification

- Send a broadcast to a bot that echoes a menu (e.g. `@BotFather` with `/help`); confirm the Replies panel shows the menu message and buttons.
- Click a callback button and confirm the bot's popup text appears as a toast; card refreshes to show the next message.
- Click a URL button and confirm the confirm dialog + new-tab open.
- Send a broadcast to multiple accounts × multiple targets and confirm all pairs render in parallel.
- FloodWait during click → account FloodWaitBadge updates, panel shows a clear inline error.
