## Bulk Power Pack v3 — 7 new bulk features

Selected: **4** Channel/Group Creator, **5** Invite to Group, **25** DM Blast to Group Members, **28** Message Editor, **29** Forwarded-From Cleaner (optional), **32** Voice/Video Note Sender, **34** Quiz/Poll Creator, **37** Read-All / Unread Marker.

All features reuse existing infrastructure: `AccountMultiPicker`, `TargetsPicker`, `runWithLimit` (parallel accounts), FloodWait handling, `action_runs` + `action_logs` for history, and the SSE streaming pattern from `/api/public/actions-stream`.

---

### 1. Backend — one new streaming route

Add a single new server route `src/routes/api/public/bulk-stream.ts` (mirrors `actions-stream.ts`) that dispatches to per-kind executors. Auth via existing `hook-auth.server.ts` (`CRON_SECRET` or admin session). Every run records to `action_runs` (kind) + `action_logs`.

New action kinds:

```text
createChat        → #4  Bulk Channel/Group Creator
inviteToChat      → #5  Bulk Invite to Group
dmBlast           → #25 DM Blast to Group Members
editSent          → #28 Bulk Message Editor
copyClean         → #29 Forwarded-From Cleaner
voiceNote         → #32 Bulk Voice/Video Note
pollCreate        → #34 Bulk Quiz/Poll Creator
readAll           → #37 Bulk Read-All / Mark Unread
```

### 2. Per-feature GramJS logic (in `src/lib/bulk-executors.server.ts`)

| # | Feature | Telegram API used |
|---|---------|-------------------|
| 4 | Channel/Group Creator | `channels.CreateChannel` (broadcast/megagroup) + optional `channels.EditPhoto`, `channels.EditAbout`, `channels.UpdateUsername`, pin first message |
| 5 | Invite to Group | Resolve target group; per account call `channels.InviteToChannel` (chunk of 50); respects "added by admin" cap; skips already-members |
| 25 | DM Blast | Scrape members via `channels.GetParticipants` (loop up to 10k) → filter (skip bots/deleted/premium optional) → distribute across sender accounts round-robin → `messages.SendMessage` with spintax + per-account signature + inter-message delay |
| 28 | Message Editor | Input: link range or message IDs already in `action_logs` (from prior broadcast). For each: `messages.EditMessage` with new text (spintax supported); handles `MESSAGE_NOT_MODIFIED` |
| 29 | Copy-clean forward | Fetch source message → re-upload media if any (`messages.SendMedia`) + send text via `messages.SendMessage` (no `forwardMessages` → strips "Forwarded from") |
| 32 | Voice Note | Upload once per account via `client.uploadFile`, then `messages.SendMedia` with `InputMediaUploadedDocument` + `DocumentAttributeAudio(voice=true)`. Same file for video note using `DocumentAttributeVideo(round_message=true)` |
| 34 | Poll/Quiz | `messages.SendMedia` + `InputMediaPoll` with `Poll` (multiple/quiz flags, correct_answer for quiz) |
| 37 | Read-All | Loop `getDialogs` → `messages.ReadHistory` on each unread; or targeted list from TargetsPicker; supports "mark unread" via `messages.MarkDialogUnread` |

Concurrency: use existing `runWithLimit(parallelAccts)`.  
FloodWait: existing `handleFloodWait` helper.  
Progress: SSE `line` events per account + summary at end.

### 3. Frontend — new "Bulk+" page

Create `src/routes/_authenticated/bulk-plus.tsx` with a left-side kind selector (icon + label) and a right-side dynamic config panel per kind. Add sidebar entry in `src/components/app-sidebar.tsx` under "Automation".

Shared UI atoms already available:
- `AccountMultiPicker` (with #N prefix + RangeApply)
- `TargetsPicker` (chat/group/channel/bot filters)
- `StreamConsole` (SSE viewer, same as Actions page)
- `SpintaxHelp` toggle box

Per-kind panels:

```text
#4  Create Chat
    - Type: [channel | supergroup | basic group]
    - Title, About, Username pattern ({n}), Photo upload
    - Pin first message textarea
    - Account picker (each account creates one)

#5  Invite to Chat
    - Destination: pick 1 chat (owned by one of selected accounts)
    - User source: paste usernames/IDs OR "scrape from source group"
    - Sender accounts (must be admin of destination)
    - Per-account daily cap slider (default 30)

#25 DM Blast
    - Source group link (to scrape members)
    - Filters: [skip bots] [skip deleted] [skip mutual contacts] [only online < 7d]
    - Message (spintax + preview)
    - Sender accounts + msg/account cap + min/max delay
    - Precheck button (dry run → shows reachable count)

#28 Edit Sent
    - Mode: [by action_run_id (dropdown of past broadcasts)] | [paste links]
    - New text (spintax)
    - Optional: only edit if current text matches regex

#29 Copy-Clean Forward
    - Source message link
    - Sender accounts + destinations (TargetsPicker)
    - Toggle: [also strip captions] [add signature]

#32 Voice/Video Note
    - File upload (audio for voice, mp4 square for video note)
    - Toggle voice vs video-note
    - Sender accounts + destinations

#34 Poll/Quiz
    - Question, options (2-10), toggles: multiple, anonymous, quiz
    - If quiz: correct answer index + explanation
    - Sender accounts + destinations

#37 Read-All
    - Scope: [all dialogs] | [selected via TargetsPicker]
    - Mode: [mark read] | [mark unread]
    - Account picker
```

### 4. DB — one migration

`action_runs_kind_check` constraint extension to accept 8 new kinds:

```sql
alter table public.action_runs drop constraint action_runs_kind_check;
alter table public.action_runs add constraint action_runs_kind_check
  check (kind in (
    'broadcast','comment','reply','deleteMessages','edit','botFlow','botflow',
    'forward','reactions','viewBoost','joinLinks','profileUpdate',
    -- new:
    'createChat','inviteToChat','dmBlast','editSent','copyClean',
    'voiceNote','pollCreate','readAll'
  ));
```

No new tables — reuse `action_runs` + `action_logs`.

### 5. Rollout order (in one build)

1. Migration (constraint update)
2. `src/lib/bulk-executors.server.ts` (all 8 executors)
3. `src/routes/api/public/bulk-stream.ts` (dispatcher + auth)
4. `src/routes/_authenticated/bulk-plus.tsx` (UI with kind switcher)
5. Sidebar link
6. Smoke test each kind via existing SSE console

### Notes / caveats

- **#5 Invite**: Telegram caps ~200 adds/account/day and users who set "who can add me → contacts only" will fail — we log per-user reason, don't retry-loop.
- **#25 DM Blast**: extremely spam-flag-prone. UI shows a red warning + forced min delay ≥ 30s + max 20 DMs/account/day default. User can override but sees confirm dialog.
- **#32 Voice notes**: file must be OGG/Opus for true voice bubble; MP3 gets sent as regular audio. We'll auto-detect and warn.
- **#34 Quiz**: correct answer stored per-account (same for all).
- **#37 Read-All**: no undo. Confirm dialog required.

Ready — reply **go** to build all 8, or tell me to drop/reorder any.
