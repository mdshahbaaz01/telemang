# Plan: Bulk manager v2 — new actions, account groups, alerts, and Telegram-style chat viewer

Ships the confirmed features plus a global "tap any ID → open Telegram-style chat" experience. Everything reuses the existing scheduler and per-account timing report so IST accuracy stays intact.

## Scope (all confirmed)

**New actions**
1. Bulk reactions — weighted emoji mix, optional time-spread over N min (#38), randomized account order (#39)
2. View boost — bump post view count from N accounts
3. Profile updater — single or bulk (name, bio, username, avatar)
12. Albums — multi-photo/video posts in broadcast
18. Repost mode in Forwarder — drops "forwarded from" header
29. Auto-leave X days after join in bulk-join tasks

**Cross-cutting**
- A. Account groups / tags — reusable in every action
- G. Telegram alert to owner — bot DM on ban / job failure / PEER_FLOOD spike
- CHAT VIEWER — every ID/handle/link becomes a chip; tap opens a full mini-Telegram side panel (info + last messages + reply composer + members)

## User-facing surfaces

### Chat viewer (new, global)
- `<ChatIdChip id="...">` — used everywhere IDs render (target chips, report table, error logs, join task rows, groups page)
- Right-side drawer (72rem max) with three tabs: **Messages** · **Info** · **Members**
  - Messages: infinite scroll upward, media thumbnails, jump-to-latest, "reply from account" composer at bottom
  - Info: title, avatar, ID, type, member count, description, invite link, participant status, admin/creator badges
  - Members: paginated list (admins only when API restricts), search, quick-DM
- Top of drawer: **account switcher** — auto-picks healthiest account by default; dropdown lets you view "as" any other account
- "Open in Telegram" button (`tg://resolve`)
- 60s per-(account,target) cache so re-taps are instant

### New action tabs (Actions page)
- `reaction` — pick message link → emoji picker with weight sliders (each row: emoji + %) → account selector → optional "spread over N min" + "randomize order" → run or schedule
- `viewBoost` — pick message link → select accounts → run/schedule
- `broadcast` gets an **Album** toggle: attach up to 10 media files, sent as one grouped post
- Forwarder gets a **Repost (hide origin)** toggle
- Bulk-join task edit form gets **Auto-leave after N days** field

### Profile updater (new page)
- `/profile-updater` — sidebar entry
- **Single mode**: pick one account, edit any subset of fields, preview, apply
- **Bulk mode**: select accounts + apply same values, OR upload CSV `(account_id,first_name,last_name,bio,username,avatar_url)`
- Per-account result log with success/failure

### Account groups (Owner / Accounts page)
- Create/rename/delete groups (e.g. "India warm", "Aged 2024", "Test5")
- Assign accounts to zero or more groups (many-to-many)
- Every account picker in the app gets a "Select group" quick-filter that adds all members of a group in one click

### Owner alerts (extends existing bot flow)
- Settings pane under `/alerts`: toggles for
  - Account banned / session invalidated
  - PEER_FLOOD or FLOOD_WAIT > threshold
  - Scheduled job failed / partially failed
  - Daily summary at chosen IST time
- Delivery: DM from your existing bot to a chosen chat ID; falls back to `notification_logs`

## Technical Details

### Database
```sql
-- Account groups
create table public.account_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now()
);
grant select,insert,update,delete on public.account_groups to authenticated;
grant all on public.account_groups to service_role;
alter table public.account_groups enable row level security;
create policy "own groups" on public.account_groups
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.account_group_members (
  group_id uuid not null references public.account_groups(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete cascade,
  primary key (group_id, account_id)
);
-- grants + RLS via join on account_groups.user_id

-- Bulk-join auto-leave (extend existing join_tasks)
alter table public.join_tasks
  add column auto_leave_after_days integer;

-- Alert prefs
alter table public.notification_settings
  add column alert_on_ban boolean default true,
  add column alert_on_peer_flood boolean default true,
  add column alert_on_job_failure boolean default true,
  add column daily_summary_ist_time text; -- "20:00"
```

### Server functions
- `src/lib/reactions.functions.ts` — `runReactionsLive`, uses existing scheduling path for scheduled runs
- `src/lib/view-boost.functions.ts` — same shape
- `src/lib/profile.functions.ts` — `previewProfileChange`, `updateProfileBulk`
- `src/lib/account-groups.functions.ts` — CRUD + `listAccountsByGroup`
- `src/lib/chat-viewer.functions.ts`:
  - `previewChat({ target, accountId? })` → dialog info + latest 30 messages
  - `loadChatHistory({ target, accountId, beforeMsgId })` → older messages
  - `loadChatMembers({ target, accountId, cursor })`
  - `sendQuickReply({ target, accountId, message })`
- `src/lib/schedule.functions.ts` — extend payload schemas for `reaction`, `viewBoost`, `profileUpdate`, `album`
- `src/lib/broadcast-executor.server.ts` — add `executeReaction`, `executeViewBoost`, `executeProfileUpdate`, album path in `executeBroadcast` (uses `sendFile` with array), repost path in `executeForward` (fetches then sends as new)

### Chat viewer implementation
- GramJS calls: `messages.getDialogs` (once per account, cached), `messages.getHistory`, `channels.getParticipants`, `messages.sendMessage`
- Media thumbnails: return signed URLs from lightweight backend proxy (`/api/public/chat-media/:accountId/:msgId`) since Telegram media needs the user session
- Auto-pick account: query `telegram_accounts` where `cooldown_until` is null and last_error is null, order by last_active_at desc
- Component structure:
  - `src/components/chat/ChatIdChip.tsx`
  - `src/components/chat/ChatViewerDrawer.tsx` (Sheet from shadcn)
  - `src/components/chat/ChatMessagesTab.tsx`, `ChatInfoTab.tsx`, `ChatMembersTab.tsx`
  - `src/components/chat/AccountViewerPicker.tsx`
- Global mount: `<ChatViewerHost />` in `_authenticated/route.tsx` listens to a `chatViewerStore` (Zustand) so any chip anywhere opens the same drawer

### Auto-leave for join tasks
- On join task run: also insert a row into `join_task_items` with `leave_after = created_at + N days`
- Cron worker picks items where `leave_after < now()` and status = 'joined', calls `channels.leaveChannel`

### Owner alerts wiring
- In `broadcast-executor.server.ts` and `run-scheduled-broadcasts.ts`, on ban/PEER_FLOOD/job-failure, call `notifyOwner({ userId, kind, message })` from `notifications.server.ts`
- `notifyOwner` reads `notification_settings`, sends Telegram DM via existing bot API, and inserts into `notification_logs`
- Daily summary: new cron `/api/public/hooks/daily-summary` runs every 15 min, checks each user's `daily_summary_ist_time`, sends summary if not yet sent today

### Reaction time-spread + randomization
- In `buildQueueItems`, when kind='reaction' and `spreadSeconds > 0`: `firesAt(i) = scheduled_at + random(0, spreadSeconds*1000)`; shuffle account order before mapping
- Otherwise fires_at = scheduled_at for all

### Album payload
- Broadcast row schema: `attachment` becomes `attachments: File[]` (max 10) in UI; server payload stores `attachments: [{path, filename, mimeType}]`
- Executor: if `attachments.length > 1` use `client.sendFile(dest, { file: [...] })` grouped as album

## Build order
1. Account groups + picker integration (foundation)
2. Chat viewer core (`previewChat` + drawer + chips in target lists)
3. Bulk reactions (with 38 + 39)
4. View boost
5. Albums in broadcast
6. Repost mode in forwarder
7. Profile updater
8. Auto-leave in join tasks
9. Owner alerts + daily summary
10. Chat viewer members tab + quick reply

Approve to build phases 1–3 in the first pass; phases 4–10 in follow-up passes to keep each change reviewable.
