# Plan — Feature batch (1, 3, 6, 13, 20, 32, 42)

Note on **#21 (Bulk profile updater)** — already implemented at `/profile-updater` (`src/lib/profile.functions.ts` + route). I'll skip re-building and only add a small link/callout so you can find it faster. Say the word if you want it expanded (per-account templating with spintax + `{n}`).

---

## 1. Spintax + variables in messages
- New `src/lib/spintax.ts` — `renderSpintax(text, vars)` supporting:
  - `{a|b|c}` random pick (nested).
  - Tokens: `{n}`, `{first_name}`, `{last_name}`, `{username}`, `{account_index}`, `{account_name}`.
- Wire into `formatMessage` pipeline (`src/lib/message-format.ts`) so **every** send path (broadcast, reply, comment, forwarder captions, scheduled) renders spintax per-recipient.
- Resolver runs in `broadcast-executor.server.ts` and `actions-stream.ts` right before `sendMessage/sendFile`, using the resolved dest entity to fill `{first_name}` etc.
- UI: small "Spintax help" popover next to the format buttons + live preview shows one random render.

## 3. Message templates library
- New table `message_templates (id, user_id, name, body, format, attachments jsonb, created_at)` with RLS + grants.
- `src/lib/templates.functions.ts` — list/save/delete/update.
- UI: "Templates" dropdown in Broadcast, Reply, Comment cards → **Save as template** / **Load template**. Attachments stored as storage paths (same bucket).

## 6. Per-account signature suffix
- Add `signature text` column to `accounts` table (migration).
- Editable in Accounts list (inline) and in a new field on the per-account row inside Broadcast/Reply.
- Executor appends `\n\n{signature}` (respecting selected format) when non-empty. Works with spintax too.

## 13. Parallel account execution with global concurrency slider
- Replace `Promise.all(byAccount…)` in `broadcast-executor.server.ts`, `executeReply`, `executeForward`, and the corresponding blocks in `actions-stream.ts` with a small `pLimit(concurrency)` helper (`src/lib/p-limit.ts`, no dep).
- Add `concurrency` (1–20, default 5) to all Zod input schemas and the request payloads.
- UI: single slider in the Actions page header ("Accounts in parallel: N") persisted to `localStorage`, applied to broadcast/reply/comment/forward/bulk-mix runs.

## 20. Bulk mute / unmute / archive / pin
- Extend `cleanup-stream.ts` with a new `dialogAction` kind: `{ op: 'mute'|'unmute'|'archive'|'unarchive'|'pin'|'unpin', targets: string[], accountIds: string[] }`.
- Uses `Api.account.UpdateNotifySettings`, `Api.folders.EditPeerFolders` (folder 1 = archive, 0 = main), `Api.messages.ToggleDialogPin`.
- New "Bulk chat actions" tab on `/cleanup` with `AccountMultiPicker` + `TargetsPicker` + op selector.

## 32. Live dashboard — per-account health
- Rebuild `/dashboard` with a table: account, status (connected/floodwait/banned/offline), current FloodWait remaining (ticks live), last-seen, quota used today (msgs / joins / leaves), errors last 24h count.
- Data sources: existing `accounts` table + `action_runs` aggregation + FloodWait store already in memory (surface via new `getAccountsHealth` server fn).
- Auto-refresh every 10s (React Query `refetchInterval`).

## 42. Global search across accounts
- New route `/search` with input + account multi-select + scope tabs (Chats / Messages / Users).
- Server fn `globalSearch(query, accountIds, scope)` runs `Api.contacts.Search` (chats/users) or `Api.messages.SearchGlobal` (messages) in parallel per account with `pLimit`.
- Results grouped by account with click → open `ChatViewerDrawer` at that message.
- ⌘K / Ctrl-K opens the search route from anywhere.

---

## Order of execution
1. Migrations (`message_templates`, `accounts.signature`).
2. Shared utils (`spintax.ts`, `p-limit.ts`).
3. Executor changes (concurrency + spintax + signature) — all three land together to avoid double-touching hot files.
4. Templates + UI wiring.
5. Cleanup dialogAction + tab.
6. Dashboard rebuild.
7. Global search route + ⌘K.

## Out of scope for this batch
- AI rewrite/translate (#2), A/B split (#4), recurring schedule (#5), silent send (#7) — say the word and I'll add them next.
- Full rebuild of profile updater (#21) — already exists.

Reply **go** to start, or tell me which items to drop/re-order.